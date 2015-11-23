var path = require('path');
var fs = require('fs');
var ONE_FILE_MSG = /([^\s"]*\.(\w*))\",[\s]*line[\s]*(\d*)(,[\s]*character[s]*[\s]*(\d*)-(\d*))?([\s\S]*)/;

/**
 * Need to be careful. Errors are separated by File: "file/path", but some
 * errors will include a secondary reference file that is *indented* such as
 *
 *    |
 *    |
 *    |File: "file/path" characters blah blah
 *    |   Some error description. Here's another file for reference that should
 *    |   be considered part of the same file:
 *    |   File: "another/file/path" characters blah blah
 *    |
 *    |
 */
var AT_LEAST_ONE_MSG = /(^File \"([\s\S]*))/m;


var ERROR = 'ERROR';
var WARNING = 'WARNING';

var NOT_COMPATIBLE_RE = /is not compatible with type/;
// This error should be filtered because the more meaningful syntax error will
// already be reported.
var IGNORE_PREPROCESSOR_ERR = /Error: Error while running external preprocessor[\s\S]*/;

/**
 * Perhaps this should be applied everywhere we see a type.
 */
var splitEquivalentTypes = function(typeStr) {
  return typeStr.split(/=/).filter(function(typ) {
    return typ && typ.trim() !== '';
  });
};

var getConflictPairs = function(incompatText) {
  var splitByIsNotCompatibleWith = incompatText &&
    incompatText.match(/is not compatible with type/) &&
    incompatText.split(/is not compatible with type/);
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
    conflictPairs.push({
      inferred: splitEquivalentTypes(conflicts[i]),
      expected: splitEquivalentTypes(conflicts[i+1])
    });
  }
  return conflictPairs;
};
var ErrorExtractors = [
  {
    kind: "TypeErrors.MismatchTypeArguments",
    extract: function(content) {
      var regex = /Error: The type constructor\s*([\w\.]*)\s*expects[\s]*(\d+)\s*argument\(s\),\s*but is here applied to\s*(\d+)\s*argument\(s\)/;
      // Sometimes they don't.
      var match = content.match(regex);
      if (match) {
        var typeConstructor = match[1];
        return {
          type: ERROR,
          details: {
            typeConstructor: typeConstructor,
            expectedCount: match[2],
            observedCount: match[3]
          }
        };
      } else {
        return null;
      }
    }
  },
  {
    kind: "TypeErrors.UnboundValue",
    extract: function(content) {
      var regexField = /Error: Unbound value ([\w\.]*)[\s\S](Hint:([\s\S]*))?/;
      // Sometimes they don't.
      var moduleMatch = content.match(regexField);
      if (moduleMatch) {
        var expression = moduleMatch[1];
        var hint = moduleMatch[3] && moduleMatch[3].trim();
        return {type: ERROR, details: {expression: expression, hint: hint}};
      } else {
        return null;
      }
    }
  },
  {
    kind: "TypeErrors.SignatureMismatch",
    extract: function(content) {
      var regexField = /Error: Signature mismatch:[\s\S]*Values do not match:([\s\S]*)is not included in([\s\S]*)File "([\s\S]*)/;
      // Sometimes they don't.
      var match = content.match(regexField);
      if (match) {
        var inferredValueType = match[1];
        var expectedValueType = match[2];
        var fileAndLineErrorContents = match[3];
        var actualDeclaractionFileAndLineErrorMatch =
          fileAndLineErrorContents.match(ONE_FILE_MSG)
        if (!actualDeclaractionFileAndLineErrorMatch) {
          // Don't know what this form means.
          return null;
        }
        var declarationFileInfo = extractFileInfoFromError(actualDeclaractionFileAndLineErrorMatch);
        return {
          type: ERROR,
          details: {
            inferredValueType: inferredValueType,
            expectedValueType: expectedValueType,
            declarationLocation: {
              filePath: declarationFileInfo.filePath,
              fileText: declarationFileInfo.fileText,
              range: [[declarationFileInfo.line, declarationFileInfo.characterStart], [declarationFileInfo.line, declarationFileInfo.characterEnd]],
            }
          }
        };
      } else {
        return null;
      }
    }
  },
  {
    kind: "TypeErrors.SignatureItemMissing",
    extract: function(content) {
      var regexField =
        /Error: Signature mismatch:[\s\S]*?(The[\s\S]*is required but not provided[\s\S*])/;
      // Sometimes they don't.
      var match = content.match(regexField);
      if (match) {
        return {
          type: ERROR,
          details: {
            missingItems: match[1].split('\n').filter(function(s) {return !!s;})
          }
        };
      } else {
        return null;
      }
    }
  },
  {
    kind: "TypeErrors.UnboundModule",
    extract: function(content) {
      var regexField = /Error: Unbound module ([\w\.]*)[\s\S](Hint:([\s\S]*))?/;
      // Sometimes they don't.
      var match = content.match(regexField);
      if (match) {
        var moduleName = match[1];
        var hint = match[3] && match[3].trim();
        return {type: ERROR, details: {moduleName: moduleName, hint: hint}};
      } else {
        return null;
      }
    }
  },
  {
    kind: "TypeErrors.UnboundRecordField",
    extract: function(content) {
      var regexField = /Error: Unbound record field (\w*)[\s\S](Hint:([\s\S]*))?/
      // Sometimes they don't.
      var match = content.match(regexField);
      if (match) {
        var fieldName = match[1];
        var hint = match[3] && match[3].trim();
        return {type: ERROR, details: {fieldName: fieldName, hint:hint}};
      } else {
        return null;
      }
    }
  },
  {
    kind: "TypeErrors.UnboundConstructor",
    extract: function(content) {
      var regexField = /Error: Unbound constructor ([\w\.]*)[\s\S](Hint:([\s\S]*))?/
      // Sometimes they don't.
      var match = content.match(regexField);
      if (match) {
        var namespacedConstructor = match[1];
        var hint = match[3] && match[3].trim();
        return {type: ERROR, details: {namespacedConstructor: namespacedConstructor, hint:hint}};
      } else {
        return null;
      }
    }
  },
  {
    kind: "TypeErrors.UnboundTypeConstructor",
    extract: function(content) {
      var regexField = /Error: Unbound type constructor ([\w\.]*)[\s\S](Hint:([\s\S]*))?/
      // Sometimes they don't.
      var match = content.match(regexField);
      if (match) {
        var namespacedConstructor = match[1];
        var hint = match[3] && match[3].trim();
        return {type: ERROR, details: {namespacedConstructor: namespacedConstructor, hint:hint}};
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
    kind: "TypeErrors.RecordFieldNotInExpression",
    extract: function(content) {
      var regexField =
        /This expression has type([\s\S]*)The field\s*(\w*)[\s\S]*does not belong to type\s*([\s\S]*)/
      // Sometimes they don't.
      var match = content.match(regexField);
      if (match) {
        var expressionType = match[1];
        var fieldName = match[2];
        var belongToTypeAndHint = match[3].split('Hint:');
        return {
          type: ERROR,
          details: {
            expressionType: expressionType,
            fieldName: fieldName,
            belongToType: belongToTypeAndHint[0],
            hint: belongToTypeAndHint[1]
          }
        };
      } else {
        return null;
      }
    }
  },
  {
    kind: "TypeErrors.RecordFieldError",
    extract: function(content) {
      var regexField =
        /This record expression is expected to have type([\s\S]*)The (field|constructor)\s*(\S*)\s*does not belong to type\s*([\s\S]*)/
      // Sometimes they don't.
      var match = content.match(regexField);
      if (match) {
        var recordType = match[1];
        var fieldName = match[3];
        var hint = match[5];
        var belongToTypeAndHint = match[4].split('Hint:');
        return {
          type: ERROR,
          details: {
            fieldOrConstructor: match[2],
            recordType: recordType,
            fieldName: fieldName,
            belongToType: belongToTypeAndHint[0],
            hint: belongToTypeAndHint[1] || null
          }
        };
      } else {
        return null;
      }
    }
  },
  {
    kind: "FileErrors.SyntaxError",
    extract: function(content) {
      // Sometimes they don't.
      var fieldMatch = content.match(/Error: Syntax error[:]*([\s\S]*)/);
      if (fieldMatch) {
        return {
          type: ERROR,
          details: {
            hint: fieldMatch[1]
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
      // Using non-"greedy" regexes messes up the regex! We need to use,
      // standard greedy with (pat | $) *not* in multiline mode.
      // Sometimes the type errors have elaboration (Type x is not compatible with y)
      var inferredIndex = 1;
      var expectedIndex = 2;
      var incompatIndex = 4;
      var escapeScopeIndex = 6;
      var incompatPatRegex =
        /Error: This pattern matches values of type([\s\S]*?)but a pattern was expected which matches values of type([\s\S]*?)(Type\b([\s\S]*?)|$)?((The type constructor[\s\S]*?)|$)?((The type variable[\s\S]*)|$)/;
      var incompatExprRegex =
        // Very nuanced regex.
        /Error: This expression has type([\s\S]*?)but an expression was expected of type([\s\S]*?)(Type\b([\s\S]*?)|$)?((The type constructor[\s\S]*?)|$)?((The type variable[\s\S]* occurs inside ([\s\S])*)|$)/ 
      var exprMatch = content.match(incompatExprRegex);
      var patMatch = content.match(incompatPatRegex);
      var match = exprMatch || patMatch;
      if (match) {
        var inferred = match[inferredIndex];
        var expected = match[expectedIndex];
        var incompatText = match[incompatIndex];
        var conflictPairs = getConflictPairs(incompatText);
        return {
          type: ERROR,
          details: {
            termKind: exprMatch ? 'expression' : 'pattern',
            inferred: inferred,
            expected: expected,
            inferredEquivalentTypes: splitEquivalentTypes(inferred),
            expectedEquivalentTypes: splitEquivalentTypes(expected),
            conflicts: conflictPairs,
            existentialMessage: match[escapeScopeIndex] && match[escapeScopeIndex].trim()
          }
        };
      } else {
        return null;
      }
    }
  },
  {
    kind: "TypeErrors.NotAFunction",
    extract: function(content) {
      var regex = /This expression has type([\s\S]*)This is not a function; it cannot be applied./
      var match = content.match(regex);
      if (match) {
        var type = match[1];
        return {
          type: ERROR,
          details: {
            type: type
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
    extract: function(stdErrorOutput) {
      var r = /Error: ([\s\S]*)/
      // Sometimes they don't.
      var match = stdErrorOutput.match(r);
      if (match) {
        var msg = match[1];
        return {type: ERROR, details: {msg: msg}};
      } else {
        return null;
      }
    }
  },
];


var extractFileInfoFromError = function(fileAndLineErrorMatch) {
  if (!fileAndLineErrorMatch) {
    throw new Error('Could not extract info from file error message');
  }
  var filePath = fileAndLineErrorMatch[1];
  var fileText = require('fs').readFileSync(filePath).toString();
  var line = +fileAndLineErrorMatch[3];
  var characterStart = fileAndLineErrorMatch[5] != null ? +fileAndLineErrorMatch[5] : 0;
  var characterEnd = fileAndLineErrorMatch[6] != null ? +fileAndLineErrorMatch[6] : 0;
  return {
    filePath: filePath,
    fileText: fileText,
    line: line,
    characterStart: characterStart,
    characterEnd: characterEnd
  };
};

exports.extractFromStdErr = function(originatingCommands, stdErrorOutput, logUnextractedErrors) {
  // your code here
  var fileAndLineErrorMatch = stdErrorOutput.match(AT_LEAST_ONE_MSG);
  if (fileAndLineErrorMatch) {
    var matched = fileAndLineErrorMatch[1];
    var eachItem = matched.split(/^File \"/m);
    var errors = [];
    eachItem.forEach(function(str) {
      if (str) {
        var recoverStdErr = "File \"" + str;
        errors = errors.concat(exports.extractFromStdErrOne(originatingCommands, recoverStdErr, logUnextractedErrors));
      }
    });
    return errors;
  } else {
    return [];
  }
};

/**
 * Provides feedback about the most common errors that weren't beautifully
 * formatted. We'll prioritize the top occurrences.
 */
var unextractedErrorLogFilePath = path.join(
  process.cwd(),
  'error_formatter_failed_attempts_commit_me_so_we_know_what_to_improve.txt'
);

// Helps to prevent merge conflicts.
var unextractedErrorLogEntryPrefix = 'UNEXTRACTED_ERROR:' + process.env['USER'] + ':';

var doLogUnextractedError = function(stdErrorOutput) {
  if (!fs.existsSync(unextractedErrorLogFilePath)) {
    fs.writeFileSync(unextractedErrorLogFilePath, '');
  };
  var existingContents = fs.readFileSync(unextractedErrorLogFilePath).toString();
  var entries = existingContents.split(/UNEXTRACTED_ERROR:(\w*):/);
  for (var i = 0; i < entries.length; i++) {
    if (entries[i] == stdErrorOutput) {
      return;
    };
  }
  try {
    fs.appendFile(unextractedErrorLogFilePath, unextractedErrorLogEntryPrefix + stdErrorOutput, function (err) {
      if (err) {
        console.error('Error extractor failed to log unextracted error: Not going to block the build, but REPORT THIS ISSUE');
        console.error(err);
      }
    });
  } catch (e) {
    console.error('Error extractor failed to log unextracted error: Not going to block the build, but REPORT THIS ISSUE');
    console.error(e);
  }
};

exports.extractFromStdErrOne = function(originatingCommands, stdErrorOutput, logUnextractedErrors) {
  var fileAndLineErrorMatch = stdErrorOutput.match(ONE_FILE_MSG);
  var errors = [];
  if (fileAndLineErrorMatch) {
    // Skip syntax preprocessor errors since they'll typically be better
    // reported as syntax errors
    var shouldIgnore = stdErrorOutput.match(IGNORE_PREPROCESSOR_ERR);
    if (shouldIgnore) {
      return [];
    }
    var fileInfo = extractFileInfoFromError(fileAndLineErrorMatch);
    var foundMatch = false;
    for (var i = 0; i < ErrorExtractors.length && !foundMatch; i++) {
      var match = ErrorExtractors[i].extract(stdErrorOutput);
      if (match) {
        var nextErr = {
          scope: 'file',
          providerName: 'CommonML',
          type: match.type,
          filePath: fileInfo.filePath,
          text: stdErrorOutput,
          range: [[fileInfo.line, fileInfo.characterStart], [fileInfo.line, fileInfo.characterEnd]],
          commonMLData: {
            // File text at time of error
            fileText: fileInfo.fileText,
            originalStdErr: stdErrorOutput,
            originatingCommands: originatingCommands,
            kind: ErrorExtractors[i].kind,
            details: match.details
          }
        };
        var nextKind = nextErr.commonMLData.kind;
        if ((nextKind === 'Warnings.CatchAll' || nextKind === 'General.CatchAll') && logUnextractedErrors) {
          doLogUnextractedError(stdErrorOutput);
        }
        foundMatch = true;
        errors.push(nextErr);
      }
    }
    if (!foundMatch) {
      if (logUnextractedErrors) {
        doLogUnextractedError(stdErrorOutput);
      }
      errors.push({
        scope: 'file',
        providerName: 'CommonML',
        type: ERROR,
        filePath: fileInfo.file,
        text: stdErrorOutput, // Just use the giant stderr if no pretty match
        range: [[fileInfo.line, fileInfo.characterStart], [fileInfo.line, fileInfo.characterEnd]],
        commonMLData: {
          // File text at time of error
          fileText: fileInfo.fileText,
          originalStdErr: stdErrorOutput,
          originatingCommands: originatingCommands,
          kind: 'File.Unknown',
          details: {}
        }
      });
    }
  } else {
    if (logUnextractedErrors) {
      doLogUnextractedError(stdErrorOutput);
    }
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

exports.fromStdErrForAllPackages = function(buildResults, logUnextractedErrors) {
  var res = [];
  for (var packageName in buildResults.versionedResultsByPackageName) {
    var packageBuildResults = buildResults.versionedResultsByPackageName[packageName].results;
    if (packageBuildResults.dependencyResults.err) {
      res = res.concat (
        exports.extractFromStdErr(
          packageBuildResults.dependencyResults.commands,
          packageBuildResults.dependencyResults.err,
          logUnextractedErrors
        )
      );
    }
    if (packageBuildResults.buildResults.err) {
      res = res.concat(
        exports.extractFromStdErr(
          packageBuildResults.buildResults.commands,
          packageBuildResults.buildResults.err,
          logUnextractedErrors
        )
      );
    }
  }
  return res;
};
