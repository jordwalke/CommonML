var ONE_FILE_MSG = /(\/[^\s]*\.(\w*))\",[\s]*line[\s]*(\d*)(,[\s]*character[s]*[\s]*(\d*)-(\d*))?([\s\S]*)/;
var AT_LEAST_ONE_MSG = /\b(File \"([\s\S]*))/;


var ERROR = 'ERROR';
var WARNING = 'WARNING';

/**
 *
 * In general, you'll see a series of File x (Warning|Error).
 * So we search for anything that looks like the first [File "], and then split on the word "File ".
 *
 *  File "path.ml", line 477, characters 78-103:
 *  Warning 20: this argument will not be used by the function.
 *  File "path.ml", line 477, characters 104-108:
 *  Warning 20: this argument will not be used by the function.
 *  File "path.ml", line 477, characters 109-114:
 *  Warning 20: this argument will not be used by the function.
 *  File "path.ml", line 480, characters 16-67:
 *  Error: This function has type
 *           ('a) thing *
 *           someType ->
 *           int
 *         It is applied to too many arguments; maybe you forgot a `;'.
 */

var NOT_COMPATIBLE_RE = /is not compatible with type/;
var TypeErrors = [
  {
    kind: "TypeErrors.UnboundRecordField",
    extract: function(content) {
      var regexField = /Error: Unbound record field (\w*)/
      // Sometimes they don't.
      var fieldMatch = content.match(regexField);
      if (fieldMatch) {
        var fieldName = fieldMatch[1];
        return {type: ERROR, details: {fieldName: fieldName }};
      } else {
        return null;
      }
    }
  },
  {
    kind: "TypeErrors.AppliedTooMany",
    extract: function(content) {
      var regexField =
        /Error: This function has type\s*([\s\S]*)\s*It is applied to too many arguments; maybe you forgot a `;'/;
      // Sometimes they don't.
      var match = content.match(regexField);
      if (match) {
        var type = match[1];
        return {type: ERROR, details: {functionType: type}};
      } else {
        return null;
      }
    }
  },
  {
    kind: "TypeErrors.RecordFieldError",
    extract: function(content) {
      var regexField =
        /This record expression is expected to have type([\s\S]*)The field\s*(\w*)[\s\S]*does not belong to type\s*([\s\S]*)(Hint:[\s\S]*)/
      // Sometimes they don't.
      var match = content.match(regexField);
      if (match) {
        var recordType = match[1];
        var fieldName = match[2];
        var belongToType = match[3];
        var hint = match[4];
        return {
          type: ERROR,
          details: {
            recordType: recordType,
            fieldName: fieldName,
            belongToType: belongToType,
            hint: hint
          }
        };
      } else {
        return null;
      }
    }
  },
  {
    kind: "BuildErrors.InconsistentAssumptions",
    extract: function(content) {
      // Sometimes they don't.
      var fieldMatch = content.match(/Error: The files\s*(\S*)\s*and\s*(\S*)\s*make inconsistent assumptions over interface\s*(\S*)/);
      if (fieldMatch) {
        return {
          type: ERROR,
          details: {
            conflictOne: fieldMatch[1],
            conflictTwo: fieldMatch[2],
            moduleName: fieldMatch[3]
          }
        };
      } else {
        return null;
      }
    }
  },
  {
    kind: "Warnings.CatchAll",
    extract: function(content) {
      var regex = /Warning (\d+):([\s\S]*)/;
      var matches = content.match(regex);
      if (matches) {
        return {type: WARNING, details: {warningFlag: +matches[1], warningMessage: matches[2].trim()}};
      } else {
        return null;
      }
    }
  },
  {
    kind: "TypeErrors.FieldNotBelong",
    extract: function(content) {
      var regexField = /Error: Unbound record field (\w*)/
      // Sometimes they don't.
      var fieldMatch = content.match(regexField);
      if (fieldMatch) {
        var fieldName = fieldMatch[1];
        return {type: ERROR, details: {fieldName: fieldName}};
      } else {
        return null;
      }
    }
  },
  {
    kind: "TypeErrors.IncompatibleType",
    extract: function(content) {
      //Error: .......
      //    ...............
      //
      // Not part of error  (newline followed by not much space)

      // Sometimes the type errors have elaboration (Type x is not compatible with y)
      var regexElaboration =
         /Error: This expression has type((\n|.)*)but an expression was expected of type((\n|.)*?)\n\s*Type\b(.*([\n|\r]\s\s\s.*)*)/m;
      // Sometimes they don't.
      var regexForNoElaboration =
         /Error: This expression has type((\n|.)*)but an expression was expected of type((\n|.)*)/m;

      var elaborateMatch = content.match(regexElaboration);
      var noElaborateMatch = content.match(regexForNoElaboration);
      if (elaborateMatch) {
        var conflictText = elaborateMatch[5];
        var splitByIsNotCompatibleWith = conflictText &&
          conflictText.match(/is not compatible with type/) &&
          conflictText.split(/is not compatible with type/);
        var conflicts = [];
        var splitByType = splitByIsNotCompatibleWith && splitByIsNotCompatibleWith.map(function(text) {
          var splitByType = text.split(/\bType\s/);
          splitByType && splitByType.forEach(function(byType){
            byType && byType.trim() && conflicts.push(byType.trim());
          });
        });
        if (conflicts.length % 2 !== 0) {
          throw new Error("Conflicts don't appear in pairs");
        }
        var conflictPairs = [];
        for (var i = 0; i < conflicts.length; i+=2) {
          conflictPairs.push({inferred: conflicts[i], expected:conflicts[i]});
        }
        return {
          type: ERROR,
          details: {
            inferred: elaborateMatch[1],
            expected: elaborateMatch[3],
            conflicts: conflictPairs,
          }
        };
      } else if (noElaborateMatch) {
        return {
          type: ERROR,
          details: {
            inferred: noElaborateMatch[1],
            expected: noElaborateMatch[3],
            conflicts: []
          }
        };
      } else {
        return null;
      }
    }
  },
  {
    // Prevents repriting the file name
    // CatchAll should remain at the bottom of the list.
    kind: "General.CatchAll",
    extract: function(content) {
      var r = /Error: ([\s\S]*)/
      // Sometimes they don't.
      var match = content.match(r);
      if (match) {
        var msg = match[1];
        return {type: ERROR, details: {msg: msg}};
      } else {
        return null;
      }
    }
  },
];

exports.extractFromStdErr = function(originatingCommands, stdErrorOutput) {
  // your code here
  var fileAndLineErrorMatch = stdErrorOutput.match(AT_LEAST_ONE_MSG);
  if (fileAndLineErrorMatch) {
    var matched = fileAndLineErrorMatch[1];
    var eachItem = matched.split(/\bFile \"/);
    var errors = [];
    eachItem.forEach(function(str) {
      if (str) {
        errors = errors.concat(exports.extractFromStdErrOne(originatingCommands, str));
      }
    });
    return errors;
  } else {
    return [];
  }
};

exports.extractFromStdErrOne = function(originatingCommands, stdErrorOutput) {
  // your code here
  var fileAndLineErrorMatch = stdErrorOutput.match(ONE_FILE_MSG);
  var errors = [];
  if (fileAndLineErrorMatch) {
    var file = fileAndLineErrorMatch[1];
    var fileText = require('fs').readFileSync(file).toString();
    var line = +fileAndLineErrorMatch[3];
    var characterStart = fileAndLineErrorMatch[5] != null ? +fileAndLineErrorMatch[5] : 0;
    var characterEnd = fileAndLineErrorMatch[6] != null ? +fileAndLineErrorMatch[6] : 0;
    var foundMatch = false;
    for (var i = 0; i < TypeErrors.length && !foundMatch; i++) {
      var match = TypeErrors[i].extract(stdErrorOutput);
      if (match) {
        errors.push({
          scope: 'file',
          providerName: 'CommonML',
          type: match.type,
          filePath: file,
          text: stdErrorOutput,
          range: [[line, characterStart], [line, characterEnd]],
          commonMLData: {
            // File text at time of error
            fileText: fileText,
            originalStdErr: stdErrorOutput,
            originatingCommands: originatingCommands,
            kind: TypeErrors[i].kind,
            details: match.details
          }
        });
        foundMatch = true;
      }
    }
    if (!foundMatch) {
      errors.push({
        scope: 'file',
        providerName: 'CommonML',
        type: ERROR,
        filePath: file,
        text: stdErrorOutput, // Just use the giant stderr if no pretty match
        range: [[line, characterStart], [line, characterEnd]],
        commonMLData: {
          // File text at time of error
          fileText: fileText,
          originalStdErr: stdErrorOutput,
          originatingCommands: originatingCommands,
          kind: 'File.Unknown',
          details: {}
        }
      });
    }
  } else {
    errors.push({
     scope: 'project',
     providerName: 'CommonML',
     type: ERROR,
     text: stdErrorOutput,
     commonMLData: {
       kind: "Project.Unknown",
       originalStdErr: stdErrorOutput,
       originatingCommands: originatingCommands,
       details: {}
     }
    });
  }
  return errors;
};

exports.fromStdErrForAllPackages = function(buildResults) {
  var res = [];
  for (var packageName in buildResults.versionedResultsByPackageName) {
    var packageBuildResults = buildResults.versionedResultsByPackageName[packageName].results;
    if (packageBuildResults.dependencyResults.err) {
      res = res.concat (
        exports.extractFromStdErr(
          packageBuildResults.dependencyResults.commands, packageBuildResults.dependencyResults.err
        )
      );
    }
    if (packageBuildResults.buildResults.err) {
      res = res.concat(
        exports.extractFromStdErr(
          packageBuildResults.buildResults.commands, packageBuildResults.buildResults.err
        )
      );
    }
  }
  return res;
};
