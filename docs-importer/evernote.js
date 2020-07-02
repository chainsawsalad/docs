'use strict';

const fs = require('fs');
const qs = require('querystring');
const argv = require('minimist')(process.argv.slice(2));
const recursive = require('recursive-readdir-sync');
const cheerio = require('cheerio');
const ora = require('ora');
const preferences = require('preferences');
const request = require('request').defaults({
    jar: true
  });

const prefs = new preferences('com.sismics.docs.importer',{
    importer: {
        daemon: false
    }
}, {
    encrypt: false,
    format: 'yaml'
});
console.log(prefs);

const rootDir = argv._[0];

const files = fs.readdirSync(rootDir, { withFileTypes: true })
    .filter(dirent => !dirent.isDirectory());

const documents = [];
files.forEach(file => {
    const dirPath = `${rootDir}/${file.name}.resources`;
    const dirExists = fs.existsSync(dirPath) && fs.lstatSync(dirPath).isDirectory();
    if (!dirExists) {
        return console.error('Invliad directory ' + dirPath);
    }

    const $ = cheerio.load(fs.readFileSync(`${rootDir}/${file.name}`));

    $('body a').remove();
    const body = $('body').text();
    const title = $('title').text();
    const created = $('meta[name="created"]').attr('content');
    const tags = ($('meta[name="keywords"]').attr('content') || '').split(', ');
    const source = 'Evernote';

    const files = recursive(dirPath);
    documents.push({ body, title, created, tags, source, files });
});

console.log(documents);
request.post({
    url: prefs.importer.baseUrl + '/api/user/login',
    form: {
      username: prefs.importer.username,
      password: prefs.importer.password,
      remember: true
    }
  }, function (error, response) {
    if (error || !response || response.statusCode !== 200) {
      console.error('\nUsername or password incorrect');
      return;
    }
    importDocuments(false, ()=>console.log('done'));
  }
);

// Import the files
const importDocuments = (remove, documentsImported) => {
    if (documents.length === 0) {
        documentsImported();
        return;
    }

    let index = 0;
    let documentResolve = () => {
        const document = documents[index++];
        if (document) {
            setTimeout(() => importDocument(document, remove, documentResolve), 0);
        } else {
            documentsImported();
        }
    };
    documentResolve();
};

// Import a file
const importDocument = (document, remove, documentResolve) => {
  const spinner = ora({
    text: 'Importing: ' + document.title,
    spinner: 'flips'
  }).start();

  let taglist = document.tags;

  // Get available tags and UUIDs from server
  request.get({
      url: prefs.importer.baseUrl + '/api/tag/list',
    }, function (error, response, body) {
    if (error || !response || response.statusCode !== 200) {
      spinner.fail('Error loading tags');
      return;
    }

    let tagsarray = {};
    for (let l of JSON.parse(body).tags) {
      tagsarray[l.name] = l.id;
    }

    // Intersect tags with existing tags on server
    let foundtags = [];
    for (let j of taglist) {
      if (tagsarray.hasOwnProperty(j) && !foundtags.includes(tagsarray[j])) {
          foundtags.push(tagsarray[j]);
      } else {
          console.warn(`Tag "${ j }" not found in system for ${ document.title }`);
      }
    }

    const data = {
      title: document.title,
      description: document.body,
      create_date: +new Date(document.created),
      language: prefs.importer.lang || 'eng',
      source: document.source,
    };
    if (foundtags.length > 0 && foundtags.length === taglist.length) {
      data.tags = foundtags;
    }

    console.log(data);

    // Create document
    request.put({
      url: prefs.importer.baseUrl + '/api/document',
      form: qs.stringify(data)
    }, function (error, response, body) {
      if (error || !response || response.statusCode !== 200) {
        spinner.fail('Upload failed for ' + document.title + ': ' + error);
        documentResolve();
        return;
      }

      let index = 0;
      let fileResolve = () => {
        const file = document.files[index++];
        if (file) {
          setTimeout(() => uploadFile(file, remove, fileResolve), 0);
        } else {
          documentResolve();
        }
      };
      fileResolve();

      const uploadFile = (file, remove, fileResolve) => {
        request.put({
          url: prefs.importer.baseUrl + '/api/file',
          formData: {
            id: JSON.parse(body).id,
            file: fs.createReadStream(file)
          }
        }, function (error, response) {
          if (error || !response || response.statusCode !== 200) {
            spinner.fail('Upload failed for ' + file + ': ' + error);
            fileResolve();
            return;
          }
          spinner.succeed('Upload successful for ' + file);
          if (remove) {
            fs.unlinkSync(file);
          }
          fileResolve();
        });
      };
    });
  });
};
