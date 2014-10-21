/* global JSZip */
(function () {
  'use strict';

  angular.module('ramlEditorApp')
    .service('importService', function importServiceFactory (
      $q,
      ramlRepository
    ) {
      var self = this;

      /**
       * Merge a file with the specified directory.
       *
       * @param  {Object}  directory
       * @param  {File}    file
       * @return {Promise}
       */
      self.mergeFile = function (directory, file) {
        // Import every other file as normal.
        if (!isZip(file)) {
          return self.importFile(directory, file);
        }

        return readFileAsText(file)
          .then(function (contents) {
            return mergeZip(directory, contents);
          });
      };

      /**
       * Merge files into the specified directory.
       *
       * @param  {Object}   directory
       * @param  {FileList} files
       * @return {Promise}
       */
      self.mergeFileList = function (directory, files) {
        var imports = Array.prototype.map.call(files, function (file) {
          return self.mergeFile(directory, file);
        });

        return $q.all(imports);
      };

      /**
       * Import a single entry into the file system.
       *
       * @param  {Object}                     directory
       * @param  {(DirectoryEntry|FileEntry)} entry
       * @return {Promise}
       */
      self.importEntry = function (directory, entry) {
        var deferred = $q.defer();

        if (entry.isFile) {
          entry.file(function (file) {
            return importFileToPath(directory, entry.fullPath, file)
              .then(deferred.resolve, deferred.reject);
          }, deferred.reject);
        } else {
          var reader = entry.createReader();

          reader.readEntries(function (entries) {
            var imports = entries.map(function (entry) {
              return self.importEntry(directory, entry);
            });

            return $q.all(imports).then(deferred.resolve, deferred.reject);
          });
        }

        return deferred.promise;
      };

      /**
       * Import a single item into the file system.
       *
       * @param  {Object}           directory
       * @param  {DataTransferItem} item
       * @return {Promise}
       */
      self.importItem = function (directory, item) {
        if (item.webkitGetAsEntry) {
          return self.importEntry(directory, item.webkitGetAsEntry());
        }

        return self.importFile(directory, item.getAsFile());
      };

      /**
       * Import a single file into the file system.
       *
       * @param  {Object}  directory
       * @param  {File}    file
       * @return {Promise}
       */
      self.importFile = function (directory, file) {
        return importFileToPath(directory, file.name, file);
      };

      /**
       * Import using an event object.
       *
       * @param  {Object}  directory
       * @param  {Object}  e
       * @return {Promise}
       */
      self.importFromEvent = function (directory, e) {
        // Handle items differently since Chrome has support for folders.
        if (e.dataTransfer.items) {
          return self.importItemList(directory, e.dataTransfer.items);
        }

        return self.importFileList(directory, e.dataTransfer.files);
      };

      /**
       * Import an array of items into the file system.
       *
       * @param  {Object}               directory
       * @param  {DataTransferItemList} items
       * @return {Promise}
       */
      self.importItemList = function (directory, items) {
        var imports = Array.prototype.map.call(items, function (item) {
          return self.importItem(directory, item);
        });

        return $q.all(imports);
      };

      /**
       * Import an array of files into the file system.
       *
       * @param  {Object}   directory
       * @param  {FileList} files
       * @return {Promise}
       */
      self.importFileList = function (directory, files) {
        var imports = Array.prototype.map.call(files, function (file) {
          return self.importFile(directory, file);
        });

        return $q.all(imports);
      };

      /**
       * Import a single file at specific path.
       *
       * @param  {String}  path
       * @param  {File}    file
       * @return {Promise}
       */
      function importFileToPath (directory, path, file) {
        return readFileAsText(file)
          .then(function (contents) {
            if (isZip(file)) {
              var dirname = path.replace(/[\\\/][^\\\/]*$/, '');

              return ramlRepository.createDirectory(directory, dirname)
                .then(function (directory) {
                  return importZip(directory, contents);
                });
            }

            return createFile(directory, path, contents);
          });
      }

      /**
       * Check whether a file is a zip.
       *
       * @param  {File}    file
       * @return {Boolean}
       */
      function isZip (file) {
        // Can't check `file.type` as it's empty when read from a `FileEntry`.
        return (/\.zip$/i).test(file.name);
      }

      /**
       * Merge a zip with a directory in the file system.
       *
       * @param  {Object}  directory
       * @param  {String}  contents
       * @return {Promise}
       */
      function mergeZip (directory, contents) {
        var zip   = new JSZip(contents);
        var files = removeCommonFilePrefixes(sanitizeZipFiles(zip.files));

        return importZipFiles(directory, files);
      }

      /**
       * Import a zip file into the current directory.
       *
       * @param  {Object}  directory
       * @param  {String}  contents
       * @return {Promise}
       */
      function importZip (directory, contents) {
        var zip   = new JSZip(contents);
        var files = sanitizeZipFiles(zip.files);

        return importZipFiles(directory, files);
      }

      /**
       * Import files from the zip object.
       *
       * @param  {Object}  directory
       * @param  {Object}  files
       * @return {Promise}
       */
      function importZipFiles (directory, files) {
        var promise = $q.when(true);

        Object.keys(files).filter(canImport).forEach(function (name) {
          promise = promise.then(function () {
            // Directories seem to be stored under the files object.
            if (/\/$/.test(name)) {
              return createDirectory(directory, name);
            }

            return createFile(directory, name, files[name].asText());
          });
        });

        return promise;
      }

      /**
       * Sanitize a zip file object and remove unwanted metadata.
       *
       * @param  {Object} originalFiles
       * @return {Object}
       */
      function sanitizeZipFiles (originalFiles) {
        var files = {};

        Object.keys(originalFiles).forEach(function (name) {
          if (/^__MACOSX\//.test(name)) {
            return;
          }

          files[name] = originalFiles[name];
        });

        return files;
      }

      /**
       * Remove the common file prefix from a files object.
       *
       * @param  {Object} prefixedFiles
       * @return {String}
       */
      function removeCommonFilePrefixes (prefixedFiles) {
        // Sort the file names in order of length to get the common prefix.
        var prefix = Object.keys(prefixedFiles)
          .map(function (name) {
            if (!/[\\\/]/.test(name)) {
              return [];
            }

            return name.replace(/[\\\/][^\\\/]*$/, '').split(/[\\\/]/);
          })
          .reduce(function (prefix, name) {
            var len = prefix.length > name.length ? name.length : prefix.length;

            // Iterate over each part and find the common prefix.
            for (var i = 1; i < len; i++) {
              if (name.slice(0, i).join('/') !== prefix.slice(0, i).join('/')) {
                return name.slice(0, i - 1);
              }
            }

            return prefix;
          })
          .join('/');

        var files = {};

        // Iterate over the original files and create a new object.
        Object.keys(prefixedFiles).forEach(function (name) {
          var newName = name.substr(prefix.length);

          // If no text is left, it must have been the root directory.
          if (newName !== '/') {
            files[newName] = prefixedFiles[name];
          }
        });

        return files;
      }

      /**
       * Check whether a certain file should be imported.
       *
       * @param  {String}  name
       * @return {Boolean}
       */
      function canImport (name) {
        return !/[\/\\]\./.test(name);
      }

      /**
       * Create a file in the filesystem.
       *
       * @param  {String}  name
       * @param  {String}  contents
       * @return {Promise}
       */
      function createFile (directory, name, contents) {
        return ramlRepository.createFile(directory, name)
          .then(function (file) {
            file.contents = contents;

            return file;
          });
      }

      /**
       * Create a directory in the file system.
       *
       * @param  {String}  name
       * @return {Promise}
       */
      function createDirectory (directory, name) {
        return ramlRepository.createDirectory(directory, name);
      }

      /**
       * Read a file object as a text file.
       *
       * @param  {File}    file
       * @return {Promise}
       */
      function readFileAsText (file) {
        var deferred = $q.defer();
        var reader   = new FileReader();

        reader.onload = function () {
          return deferred.resolve(reader.result);
        };

        reader.onerror = function () {
          return deferred.reject(reader.error);
        };

        reader.readAsBinaryString(file);

        return deferred.promise;
      }
    });
})();
