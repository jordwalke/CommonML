var async = require('async');
var child_process = require('child_process');
var asciitree = require('asciitree');
var fs = require('fs');
var exec = require('child_process').exec;
var path = require('path');
var args = process.argv;
var optimist = require('optimist');
var clc = require('cli-color');
var whereis = require('whereis');
var colors = require('colors/safe');
var extractDiagnostics = require('./extractDiagnostics');
var argv = optimist.argv;

var STYLE = path.join(__dirname, 'docGenerator', 'docStyle.css');

var CWD = process.cwd();
var OCAMLC = 'ocamlc';
var OCAMLOPT = 'ocamlopt';
var OCAMLDEP = 'ocamldep';
var OCAMLLEX = 'ocamllex';
var OCAMLYACC = 'ocamlyacc';
var OCAMLDOC = 'ocamldoc';
var OCAMLFIND = 'ocamlfind';

/**
 * Error output adheres to the following Nuclide type definitions.
 *
 *  // From Atom:
 *  type Range = [[int,int], [int, int]]
 *
    type MessageType = 'Error' | 'Warning';
 *
 *  type DiagnosticProviderUpdate = {
 *    filePathToMessages?: Map<string, Array<FileDiagnosticMessage>>;
 *    projectMessages?: Array<ProjectDiagnosticMessage>;
 *  };
 *
 *  type FileDiagnosticMessage = {
 *    scope: 'file';
 *    providerName: string;
 *    type: MessageType;
 *    filePath: string;
 *    text?: string;
 *    html?: string;
 *    range?: Range;
 *    trace?: Array<Trace>;
 *  };
 *
 *  type ProjectDiagnosticMessage = {
 *    scope: 'project';
 *    providerName: string;
 *    type: MessageType;
 *    text?: string;
 *    html?: string;
 *    range?: Range;
 *    trace?: Array<Trace>;
 *  };
 *
 *  type Trace = {
 *    type: 'Trace';
 *    text?: string;
 *    html?: string;
 *    filePath: string;
 *    range?: Range;
 *  };
 *
 *  type InvalidationMessage = {
 *    scope: 'file';
 *    filePaths: Array<string>;
 *  } | {
 *    scope: 'project';
 *  } | {
 *    scope: 'all';
 *  };
 */

var createFileDiagnostic = function(path, text) {
  return {
    scope: 'file',
    providerName: 'CommonML',
    type: 'ERROR',
    filePath: path,
    text: text,
    range: [[1, 0], [1, 0]]
  };
};

var renderFileRange = function(range) {
  return ":" + ("" + range[0][0]) + (
    range[0][1] != null ?
      " characters " + range[0][1] + (range[1] ? "-" + range[1][1] : "") :
      ""
  );
};

var renderClickableFileName = function(fileDiagnostic) {
  var append = fileDiagnostic.range ? renderFileRange(fileDiagnostic.range) : "";
  return fileDiagnostic.filePath + append;
};

var renderFileDiagnostic = function(fileDiagnostic) {
  return [
    clc.red("[" + fileDiagnostic.type + "] " + renderClickableFileName(fileDiagnostic)),
    clc.red(fileDiagnostic.text),
    fileDiagnostic.commonMLData && clc.red(fileDiagnostic.commonMLData.originalStdErr)
  ].join('\n');
};

var cliConfig = {
  hidePath: argv.hidePath,
  silent: argv.silent
};

var emptyResult = {commands: null, successfulResults: null, err: null};

var programForCompiler = function(comp) {
  return comp === 'byte' ? OCAMLC :
         comp === 'native' ? OCAMLOPT :
         comp;
};

var buildUniquenessString = function(buildConfig) {
  return '_' + buildConfig.compiler + (buildConfig.forDebug ? '_debug' : '');
};

var actualBuildDir = function(buildConfig) {
  return buildConfig.buildDir + buildUniquenessString(buildConfig);
};

var actualBuildDirForDocs = function(buildConfig) {
  return buildConfig.buildDir + buildUniquenessString(buildConfig) + '_doc';
};

var buildConfig = {
  minVersion: argv.minVersion,
  opt: argv.opt || 1,
  yacc: argv.yacc === 'true',
  compiler: argv.compiler || 'byte',
  concurrency: argv.concurrency || 4,
  buildDir: argv.buildDir || '_build',
  doc: argv.doc || false,
  forDebug: argv.forDebug === 'true',
  jsCompile: argv.jsCompile === 'true',
  // The path to graphical debugger (coming soon).
  rebuggerPath: argv.rebuggerPath || null,
  errorFormatter: argv.errorFormatter || 'default',
  // Whether or not to log futile attempts at extracting meaningful error
  // information.
  // This provides feedback about which errors are the most common.
  logUnextractedErrors: argv.logUnextractedErrors === 'true'
};

if (buildConfig.minVersion) {
  require('./version').ensureAtLeast(buildConfig.minVersion);
}

var defaultErrorFormatter = function(diagnostics) {
  return diagnostics.map(renderFileDiagnostic).join('\n\n');
};

var errorFormatter =
  buildConfig.errorFormatter === 'default' ? defaultErrorFormatter :
  require(path.join(CWD, buildConfig.errorFormatter));

function invariant(bool, msg) {
  if (!bool) {
    throw new Error(msg);
  }
}
var notEmptyString = function(s) {
  return s !== '';
};
invariant(
  !('forDebug' in argv) || argv.forDebug === 'true' || argv.forDebug === 'false',
  'You Must supply a value to --forDebug - either true or false.'
);
invariant(
  buildConfig.forDebug || !buildConfig.jsCompile,
  'Building for JS also requires building for debug. ' +
  'Supply --forDebug=true --jsCompile=true'
);

invariant(
  !('jsCompile' in argv) || (argv.jsCompile === 'true' || argv.jsCompile === 'false'),
  'You must specify either true/false for option --jsCompile'
);

invariant(
  buildConfig.jsCompile ? buildConfig.compiler === 'byte' : true,
  'Building for JS required the --compiler=byte (which is the default)'
);
invariant(
  buildConfig.compiler === 'byte' ||
  buildConfig.compiler === 'native',
  'Must supply either --compiler=byte or --compiler=native'
);

var VALID_DOCS = ['html', 'latex', 'texi', 'man', 'dot'];
invariant(
  !buildConfig.doc || VALID_DOCS.indexOf(buildConfig.doc) !== -1,
  JSON.stringify(VALID_DOCS) + ' are the only valid values for --doc='
);


var validateFlags = function(compileFlags, linkFlags, packageName) {
  compileFlags = compileFlags || [];
  linkFlags = linkFlags || [];
  if (compileFlags.indexOf('-g') !== -1 || linkFlags.indexOf('-g') !== -1) {
    throw new Error(
      'A project ' + packageName + ' has debug link/compile flags ' +
      'which should not be configured on a per package basis. ' +
      'Instead pass --forDebug=true '
    );
  }
};

var traversePackagesInOrderImpl = function(visited, resourceCache, rootPackageName, cb) {
  if (!visited[rootPackageName]) {
    visited[rootPackageName] = true;
    var subpackageNames = resourceCache[rootPackageName].subpackageNames;
    for (var i = 0; i < subpackageNames.length; i++) {
      var subpackageName = subpackageNames[i];
      traversePackagesInOrderImpl(visited, resourceCache, subpackageName, cb);
    }
    cb(rootPackageName);
  }
};
var traversePackagesInOrder = function(resourceCache, rootPackageName, cb) {
  traversePackagesInOrderImpl({}, resourceCache, rootPackageName, cb);
};

/**
 * Like `traversePackagesInOrder`, but visits the same nodes multiple times.
 */
var traversePackagesInOrderRedundantly = function(resourceCache, rootPackageName, cb) {
  var subpackageNames = resourceCache[rootPackageName].subpackageNames;
  for (var i = 0; i < subpackageNames.length; i++) {
    var subpackageName = subpackageNames[i];
    traversePackagesInOrderRedundantly(resourceCache, subpackageName, cb);
  }
  cb(rootPackageName);
};

var somePackageResultNecessitatesRelinking = function(resourceCache, rootPackageName, buildPackagesResultsCache, currentBuildId) {
  var foundOne = false;
  traversePackagesInOrder(resourceCache, rootPackageName, function(packageName) {
    if (buildPackagesResultsCache.versionedResultsByPackageName[packageName].lastBuildIdEffectingProject === currentBuildId) {
      foundOne = true;
    }
  });
  return foundOne;
};

var drawBuildGraph =  function(resourceCache, resultsCache, rootPackageName) {
  var isBlocked = function(resultsCache, packageName) {
    var currentBuildId = resultsCache.currentBuildId;
    var versionedResults = resultsCache.versionedResultsByPackageName[packageName];
    var errorState = versionedResults.results.errorState;
    return errorState === NodeErrorState.SubnodeFail;
  };
  var isFailed = function(resultsCache, packageName) {
    var currentBuildId = resultsCache.currentBuildId;
    var versionedResults = resultsCache.versionedResultsByPackageName[packageName];
    var errorState = versionedResults.results.errorState;
    return errorState === NodeErrorState.NodeFail;
  };
  var isRebuilt = function(resultsCache, packageName) {
    var currentBuildId = resultsCache.currentBuildId;
    var versionedResults = resultsCache.versionedResultsByPackageName[packageName];
    var lastBuildIdEffectingProject = versionedResults.lastBuildIdEffectingProject;
    var lastBuildIdEffectingDependents = versionedResults.lastBuildIdEffectingDependents;
    var lastSuccessfulBuildId = versionedResults.lastSuccessfulBuildId;
    return !isBlocked(resultsCache, packageName) && !isFailed(resultsCache, packageName) && (lastBuildIdEffectingProject === currentBuildId);
  };

  var getTitle = function(resultsCache, packageName) {
    if (isBlocked(resultsCache, packageName)) {
      return packageName + "☐ ";
    } else if (isFailed(resultsCache, packageName)) {
      return packageName + "☒ ";
    } else {
      if (isRebuilt(resultsCache, packageName)) {
        return packageName + "☑ ";
      } else {
        return packageName;
      }
    }
  };

  var getBuildGraph = function(seenPackageName, resourceCache, resultsCache, packageName) {
    var title = getTitle(resultsCache, packageName);
    if (seenPackageName[packageName]) {
      return title;
    }
    seenPackageName[packageName] = true;
    var subgraphs = [];
    var didSuppress = false;
    resourceCache[packageName].subpackageNames.forEach(function(name) {
      if (seenPackageName[name] && !isBlocked(resultsCache, name) && !isFailed(resultsCache, name) && !isRebuilt(resultsCache, name)) {
        didSuppress = true;
      } else {
        subgraphs.push(getBuildGraph(seenPackageName, resourceCache, resultsCache, name));
      }
    });
    return [title].concat(!didSuppress ? subgraphs : subgraphs.concat(['⋯']));
  };

  var executableTitle = "Executable(" + getTitle(resultsCache, rootPackageName) + ")";
  var tree = [executableTitle, getBuildGraph({}, resourceCache, resultsCache, rootPackageName)];
  var buildTreeLines = [
    "",
    "",
    clc.bold("Build Graph:"),
    "",
    asciitree(tree),
    "",
    "☑ Rebuild Success ☒ Rebuild Failed ☐ Rebuild Blocked ⋯ Uninteresting",
    ""
  ];
  var buildTreeText = buildTreeLines.join('\n');
  var style = {
    "☒": clc.red('☒'),
    "☑": clc.green('☑')
  };
  log(clc.art(buildTreeText, style));
};

var buildBypass = {
  skipDependencyAnalysis: !!argv.skipDependencyAnalysis
};

var notEmpty = function(o) {
  return o !== null && o !== undefined;
};


var makeSearchPathStrings = function(arr) {
  return arr.map(function(dep) {
    return '-I ' + dep;
  });
};

var objectExtension = function(buildConfig) {
  if (buildConfig.compiler === 'native') {
    return '.cmx';
  } else {
    return '.cmo';
  }
};

var log = function() {
  if (cliConfig.silent) {
    return;
  }
  var msg = clc.white;
  console.log(msg.apply(msg, arguments));
};

var logError = function() {
  var msg = clc.red;
  if (cliConfig.silent) {
    return;
  }
  console.log(msg.apply(msg, arguments));
};
var logTitle = function() {
  if (cliConfig.silent) {
    return;
  }
  var msg = clc.yellow;
  console.log(msg.apply(msg, arguments));
};
var logProgress = function() {
  if (cliConfig.silent) {
    return;
  }
  var msg = clc.green;
  console.log(msg.apply(msg, arguments));
};

var buildingMsg = '\nBuilding Root Package ' + CWD + ' [' + buildConfig.compiler + ']\n';
logTitle(buildingMsg);


var logErrorException = function(e) {
  logError('\nStack Trace:\n------------\n', e && e.stack);
};
process.on('uncaughtException', function(err) {
  logError('Uncaught exception.');
  logErrorException(err);
});

/**
 * We'll need a more intelligent deep merge for build properties.
 */
var merge = function(one, two) {
  var result = {};
  for (var key in one) {
    result[key] = one[key];
  }
  for (key in two) {
    result[key] = two[key];
  }
  return result;
};

var createSymlinkCommands = function(from, to) {
  var symlinkIsInDir = path.resolve(from, '..');

  return [
    // Ensure `from` is sufficiently created.
    ['mkdir', '-p', symlinkIsInDir].join(' '),
    // If rebuilding, trying to ln to an already linked file is an error!
    // Unix commands are the worst. So we must first touch it, then unlink
    // it before we try to link it.
    ['touch', from].join(' '),
    ['unlink', from].join(' '),
    ['ln', '-s', to, from].join(' ')
  ];
};


var stockSourceExtensions = {
  '.mli': true,
  '.ml': true,
  '.mll': true,
  '.mly': true,
};
var isSourceFile = function(absPath, packageConfig) {
  var extName = path.extname(absPath);
  if (stockSourceExtensions[extName]) {
    return true;
  }
  var extensions = packageConfig.packageJSON.CommonML.extensions;
  if (!extensions) {
    return false;
  }
  for (var i = 0; i < extensions.length; i++) {
    var extension = extensions[i];
    if (extension['interface'] === extName || extension['implementation'] === extName) {
      return true;
    }
  }
  return false;
};

var arraysDiffer = function(one, two) {
  if (one.length !== two.length) {
    return true;
  }
  for (var i = 0; i < one.length; i++) {
    if (one[i] !== two[i]) {
      return true;
    }
  }
  return false;
};

function removeBreaks(str) {
  return str.replace(/(\r\n|\n|\r)/gm,"");
}


var aliasPackModuleName = function(packageConfig) {
  return packageConfig.packageName;
};

/**
 * Path for fake .ml file that contains module aliases for every internal
 * module - opened when compiling each individual internal module.
 */
var aliasMapperFile = function(internal, packageConfig, rootPackageConfig, buildConfig, extension) {
  var unsanitizedAliasModule = path.join(
    packageConfig.realPath,
    lowerBase(aliasPackModuleName(packageConfig)) + extension
  );
  var sanitizedPackPath = sanitizedArtifact(
    unsanitizedAliasModule,
    packageConfig,
    rootPackageConfig,
    buildConfig
  );
  return sanitizedPackPath;
};

var maybeSourceKind = function(filePath, packageConfig) {
  var extName = path.extname(filePath);
  if (extName === '.ml') {
    return '.ml';
  }
  if (extName === '.mli') {
    return '.mli';
  }
  var extensions = packageConfig.packageJSON.CommonML.extensions;
  if (extensions) {
    for (var i = 0; i < extensions.length; i++) {
      var extension = extensions[i];
      if (extension['implementation'] === extName) {
        return '.ml';
      }
      if (extension['interface'] === extName) {
        return '.mli';
      }
    }
  }
  return '';
};

var buildArtifact = function(filePath, buildConfig, packageConfig) {
  var kind = maybeSourceKind(filePath, packageConfig);
  var basenameBase = path.basename(filePath, path.extname(filePath));
  return kind === '.ml' ? path.resolve(filePath, '..', basenameBase + objectExtension(buildConfig)) :
    kind === '.mli' ? path.resolve(filePath, '..', basenameBase + '.cmi') :
    'NEVER_HAPPENS';
};

var buildForExecutable = function(packageConfig, rootPackageConfig, buildConfig) {
  var unsanitizedExecPath =
    path.join(packageConfig.realPath, lowerBase(packageConfig.packageName) + '.out');
  return sanitizedArtifact(unsanitizedExecPath, packageConfig, rootPackageConfig, buildConfig);
};

// A module map, which instructs editors how to build individual files, and a
// topological ordering of project files so it can know which files should be
// recompiled when files change.
var buildForModuleMap = function(packageConfig, rootPackageConfig, buildConfig) {
  var unsanitizedExecPath =
    path.join(packageConfig.realPath, lowerBase(packageConfig.packageName) + '.moduleMap');
  return sanitizedArtifact(unsanitizedExecPath, packageConfig, rootPackageConfig, buildConfig);
};

var isExported = function(packageConfig, filePath) {
  return packageConfig.packageJSON.CommonML.exports.indexOf(upperBasenameBase(filePath)) !== -1;
};

/**
 * Doesn't matter if unsanitized === sanitized.
 */
var getPublicSourceModules = function(unsanitizedPaths, packageConfig) {
  return unsanitizedPaths.filter(function(unsanitizedPath) {
    if (maybeSourceKind(unsanitizedPath, packageConfig) !== '.ml' || !unsanitizedPath) {
      return false;
    }
    return isExported(packageConfig, unsanitizedPath);
  }).filter(notEmpty);
};

var namespaceLowercase = function(packageConfig, name) {
  var base = upperBase(name);
  var withPackageName = 'M_' + packageConfig.packageName + '__' + base;
  return lowerBase(withPackageName);
};

var namespaceUppercase = function(packageConfig, name) {
  var base = upperBase(name);
  return 'M_' + packageConfig.packageName + '__' + base;
};

var getPublicSourceDirs = function(unsanitizedPaths, packageConfig) {
  var publicModulePaths =
    getPublicSourceModules(unsanitizedPaths, packageConfig);
  return publicModulePaths.map(path.dirname.bind(path));
};

var createAliases = function(unsanitizedPaths, packageConfig) {
  return unsanitizedPaths.map(function(unsanitizedPath) {
    if (maybeSourceKind(unsanitizedPath, packageConfig) !== '.ml') {
      return '';
    }
    var base = upperBase(baseNameBase(unsanitizedPath));
    var namespacedBase = namespaceUppercase(packageConfig, base);
    var comment = "\n\n(* Namespace managed module:\n   " +
      unsanitizedPath +
      "\n *)\n";
    var alias = 'module ' + base + ' = ' + namespacedBase;
    return comment + alias;
  }).join('\n');
};

var autogenAliasesCommand = function(unsanitizedPaths, packageConfig, rootPackageConfig, buildConfig) {
  var internalModuleName = aliasPackModuleName(packageConfig, true);
  var internalAliases =
    "(* Automatically generated module aliases file [" + internalModuleName + "].\n * " +
      "All internal modules are compiled with [-open " + internalModuleName + "] \n * " +
      "so that every internal module has immediate access to every other internal module." +
       "*)" +
    createAliases(unsanitizedPaths, packageConfig);

  var internalDotMl = aliasMapperFile(true, packageConfig, rootPackageConfig, buildConfig, '.ml');
  var internalDotMli = aliasMapperFile(true, packageConfig, rootPackageConfig, buildConfig, '.mli');
  return {
    generateCommands: [
      'echo "' + internalAliases + '" > ' + internalDotMl,
      'echo "' + internalAliases + '" > ' + internalDotMli,
    ].join('\n'),
    internalModuleName: internalModuleName,
    genSourceFiles: {
      internalInterface: internalDotMli,
      internalImplementation: internalDotMl,
    }
  };
};

/**
 * /input/path.ml -> /input/namespacedPath
 */
var namespaceFilePath = function(packageConfig, absPath) {
  var base = baseNameBase(absPath);
  var namespacedBase = namespaceLowercase(packageConfig, base);
  return path.resolve(absPath, '..', namespacedBase);
};

/**
 * To compile many files at once, with extensions, we have to continuously tell the
 * compiler that each interface file should be treated as an interface file, even if
 * it's an .mli. Once you pass -intf-suffix .bla, it *expects* every interface to be
 * .blah from that point on, so we have to reset it to .mli each time we see a .mli.
 */
var getSingleFileCompileExtensionFlags = function(filePath, packageConfig) {
  var extName = path.extname(filePath);
  var kind = maybeSourceKind(filePath, packageConfig);
  if (extName !== kind) {
    var extensionFlags = [];
    // Then uses some extension - find it.
    var extensions = packageConfig.packageJSON.CommonML.extensions;
    if (extensions) {
      for (var i = 0; i < extensions.length; i++) {
        var extension = extensions[i];
        if (extension['interface'] === extName) {
          extensionFlags = ['-intf-suffix', extName, '-intf'];
        } else if (extension['implementation'] === extName) {
          extensionFlags = ['-intf-suffix', extension['interface'], '-impl'];
        }
      }
    }
    if (extensionFlags.length === 0) {
      invariant(false, 'Could not find extensions for ' + filePath);
    }
    return extensionFlags;
  }
  return kind === '.ml' ?
    ['-intf-suffix', '.mli', '-impl'] :
    ['-intf-suffix', '.mli', '-intf'];
};


/**
 * To make debugging individual compilations easier, or to integrate into IDEs,
 * we can commute the `compileCommand` into each source file's compilation to
 * spot when one compilation is failing, or to perform a faster incremental
 * compile while in the editor.
 */
var getNamespacedFileOutputCommands = function(unsanitizedPaths, packageConfig, rootPackageConfig, buildConfig) {
  return unsanitizedPaths.map(function(unsanitizedPath) {
    invariant(
      isSourceFile(unsanitizedPath, packageConfig),
      'Do not know what to do with :' + unsanitizedPath
    );
    var extensionFlags = getSingleFileCompileExtensionFlags(unsanitizedPath, packageConfig);
    var sanitizedPath =
      sanitizedArtifact(unsanitizedPath, packageConfig, rootPackageConfig, buildConfig);
    var sanitizedNamespacedModule = namespaceFilePath(packageConfig, sanitizedPath);
    return {
      globalModuleName: upperBasenameBase(sanitizedNamespacedModule),
      sourcePath: unsanitizedPath,
      compileOutputString: [
          '-o',
          sanitizedNamespacedModule,
        ].concat(extensionFlags)
        .concat([unsanitizedPath]).join(' ')
    };
  });
};

/**
 * Like `getFileOutputs`, but just the output files for ML files and not the
 * commands.
 */
var getModuleArtifacts = function(unsanitizedPaths, packageConfig, rootPackageConfig, buildConfig) {
  return unsanitizedPaths.map(function(unsanitizedPath) {
    if (!isSourceFile(unsanitizedPath, packageConfig)) {
      throw new Error('Do not know what to do with :' + unsanitizedPath);
    }
    var basename = path.basename(unsanitizedPath, path.extname(unsanitizedPath));
    return maybeSourceKind(unsanitizedPath, packageConfig) === '.ml' ?  path.resolve (
      sanitizedArtifact(unsanitizedPath, packageConfig, rootPackageConfig, buildConfig),
      '..', namespaceLowercase(packageConfig, basename) + objectExtension(buildConfig)
    ) : '';
  });
};


var getSanitizedBuildDirs = function(packageConfig, rootPackageConfig, buildConfig) {
  return [
    publicArtifactDir(packageConfig, rootPackageConfig, buildConfig),
    privateArtifactDir(packageConfig, rootPackageConfig, buildConfig),
    aliasAndExecutableArtifactDir(packageConfig, rootPackageConfig, buildConfig)
  ];
};

var getPublicSanitizedBuildDirs = function(packageConfig, rootPackageConfig, buildConfig) {
  return [
    publicArtifactDir(packageConfig, rootPackageConfig, buildConfig),
    aliasAndExecutableArtifactDir(packageConfig, rootPackageConfig, buildConfig)
  ];
};


var entireActualBuildDir = function(rootPackageConfig, buildConfig) {
  return path.resolve(rootPackageConfig.realPath, actualBuildDir(buildConfig));
};

/**
 * Artifacts start out in the failed build directory. The final step in
 * compilation is to move only the intended resources from the failed build
 * directory to the final build directory.
 *
 * This allows:
 * - Autocomplete tools to still work with the previously working build while a
 *   build is temporarily broken.
 * - Copying only the intended artifacts
 */
var sanitizedDependencyBuildDirectory = function(packageConfig, rootPackageConfig, buildConfig) {
  return path.resolve(
    entireActualBuildDir(rootPackageConfig, buildConfig),
    packageConfig.packageName
  );
};

var sanitizedDependencyBuildDirectoryForDoc = function(packageConfig, rootPackageConfig, buildConfig) {
  return path.resolve(
    path.resolve(rootPackageConfig.realPath, actualBuildDirForDocs(buildConfig)),
    packageConfig.packageName
  );
};


var sanitizedArtifact = function(absPath, packageConfig, rootPackageConfig, buildConfig) {
  var originalRelativeToItsPackage = path.relative(packageConfig.realPath, absPath);
  var upper = upperBasenameBase(absPath);
  var isExportedInnerModule = isExported(packageConfig, absPath);
  var isExecutableOrAliases = upper === packageConfig.packageName;

  // As if the original file were moved to the top of dependency build
  // directory, or public/private.
  return isExecutableOrAliases ? path.join(
      sanitizedDependencyBuildDirectory(packageConfig, rootPackageConfig, buildConfig),
      path.basename(absPath)
    ) :
    isExportedInnerModule ? path.resolve(
        publicArtifactDir(packageConfig, rootPackageConfig, buildConfig),
        path.basename(absPath)
      ) :
    path.resolve(
      privateArtifactDir(packageConfig, rootPackageConfig, buildConfig),
      path.basename(absPath)
    );
};


/**
 * We will compile one module alias mapped interface such as [MyPackage] so
 * that type signatures are always the same, and we don't need to make ugly
 * namespaces nicer in IDEs. (The individual module names will still be ugly
 * because they must be flattened).
 *
 * Then each dependency will have two directories:
 * - publicInnerModules/
 * - privateInnerModules/
 *
 * When compiling the project itself, both directories are added to the search
 * paths.
 * When compiling something that depends on it, only the public path is added.
 * When linking a final executable, search paths aren't needed, we just need
 * the topological ordering of compiled implementations.
 */
var publicArtifactDir = function(packageConfig, rootPackageConfig, buildConfig) {
  return path.join(
    sanitizedDependencyBuildDirectory(packageConfig, rootPackageConfig, buildConfig),
    'publicInnerModules'
  );
};

var privateArtifactDir = function(packageConfig, rootPackageConfig, buildConfig) {
  return path.join(
    sanitizedDependencyBuildDirectory(packageConfig, rootPackageConfig, buildConfig),
    'privateInnerModules'
  );
};

var aliasAndExecutableArtifactDir = function(packageConfig, rootPackageConfig, buildConfig) {
  return sanitizedDependencyBuildDirectory(packageConfig, rootPackageConfig, buildConfig);
};

var baseNameBase = function(filePath) {
  return path.basename(filePath, path.extname(filePath));
};

var upperBasenameBase = function(filePath) {
  var base = baseNameBase(filePath);
  return base[0].toUpperCase() + base.substr(1);
};

var ensureNotMisCase = function(packageName, validateThis, propperCases) {
  var foundErrors = [];
  var lowercaseVersionOfPropper = {};
  for (var key in propperCases) {
    lowercaseVersionOfPropper[key.toLowerCase()] = true;
  }
  for (var keyInQuestion in validateThis) {
    if (lowercaseVersionOfPropper[keyInQuestion.toLowerCase()] && !(keyInQuestion in propperCases)) {
      foundErrors.push(
        packageName +
        ' has a mispelled field in its package.json/CommonML (check the casing of ' +
        keyInQuestion +
        ').'
      );
    }
  }
  return foundErrors;
};

// Split out so that it can be done before the dependencies are validated.
var verifyPackageJSONFile = function(packageName, containingDir, packageJSON) {
  var packageJSONPath = path.join(containingDir, 'package.json');
  var msg = 'Invalid package.json for ' + packageName + ' at ' + packageJSONPath + '.\n';
  var foundPackageJSONInvalidations = [];
  var lowerKeys = Object.keys(packageJSON).map(function(k) {
    return k.toLowerCase();

  });
  if (!('CommonML' in packageJSON)) {
    if (lowerKeys.indexOf('commonml') !== -1) {
      return [createFileDiagnostic(packageJSONPath, msg + 'Fix spelling in package.json: It should be spelled "CommonML".')];
    } else {
      return [];
    }
  }
  var CommonML = packageJSON.CommonML;

  if(!packageName || !packageName.length || packageName[0].toUpperCase() !== packageName[0]) {
    foundPackageJSONInvalidations.push(createFileDiagnostic(packageJSONPath, msg + 'package.json `name` must begin with a capital letter.'));
  }
  if(!packageJSON) {
    foundPackageJSONInvalidations.push(createFileDiagnostic(packageJSONPath, msg + 'Must have package.json'));
  }
  if(!CommonML.exports) {
    foundPackageJSONInvalidations.push(createFileDiagnostic(packageJSONPath, msg + 'Must specify exports'));
  }
  if(CommonML.export) {
    foundPackageJSONInvalidations.push(createFileDiagnostic(packageJSONPath, msg + '"export" is not a valid field of "CommonML" in package.json'));
  }
  var miscased = ensureNotMisCase(packageName, CommonML, {
    exports: true,
    compileFlags: true,
    linkFlags: true,
    jsPlaceBuildArtifactsIn: true,
    docFlags: true,
    extensions: true,
    preprocessor: true,
    findlibPackages: true
  });
  miscased = miscased.concat(ensureNotMisCase(packageName, packageJSON, {
    CommonML: true
  }));
  if (miscased.length !== 0) {
    miscased.forEach(function(miscasing) {
      foundPackageJSONInvalidations.push(
        createFileDiagnostic(packageJSONPath, msg + miscasing)
      );
    });
  }

  var htmlPage = CommonML.jsPlaceBuildArtifactsIn;
  if (htmlPage) {
    if(typeof htmlPage !== 'string') {
      foundPackageJSONInvalidations.push(createFileDiagnostic(packageJSONPath, packageName + ' htmlPage field must be a string'));
    }
    if(htmlPage.charAt(0) === '/' || htmlPage.charAt(0) === '.') {
      foundPackageJSONInvalidations.push(
        createFileDiagnostic(packageJSONPath, packageName + ' htmlPage must be relative to the package root with no leading slash or dot')
      );
    }
    if(htmlPage.charAt(htmlPage.length - 1) === '/') {
      foundPackageJSONInvalidations.push(
        createFileDiagnostic(packageJSONPath, packageName + 'has a jsPlaceBuildArtifactsIn that ends with a slash. Remove the slash')
      );
    }
  }
  return foundPackageJSONInvalidations;
};

var verifyPackageConfig = function(packageResource, resourceCache) {
  var foundErrors = [];
  var realPath = packageResource.realPath;
  var packageName = packageResource.packageName;
  var packageJSONPath = path.join(realPath, 'package.json');
  var packageJSON = packageResource.packageJSON;
  var CommonML = packageJSON.CommonML;
  var msg = 'Invalid package ' + packageName + ' at ' + realPath + '. ';


  var sourceFiles = packageResource.packageResources.sourceFiles;
  for (var i = 0; i < sourceFiles.length; i++) {
    var sourceFile = sourceFiles[i];
    var extName = path.extname(sourceFile);
    var kind = maybeSourceKind(sourceFile, packageResource);
    if (kind === '.mli' || kind === '.ml') {
      // Chop off any potential 'ml'
      var basenameBase = path.basename(sourceFile, extName);
      if (basenameBase.toLowerCase() === packageResource.packageName.toLowerCase()) {
        foundErrors.push(
          createFileDiagnostic(sourceFile,  msg + 'Package cannot contain module with same name as project (' + sourceFile + ')')
        );
      }
    }
  }

  if (!realPath) {
    foundErrors.push(createFileDiagnostic(packageJSONPath, msg + 'No path for package.'));
  }
  CommonML.exports.forEach(function(exportName) {
    exportName === '' && foundErrors.push(createFileDiagnostic(packageJSONPath, 'package.json specifies an exported CommonML module that is the empty string'));
    path.extname(exportName) !== '' && foundErrors.push(createFileDiagnostic(packageJSONPath, msg + 'Exports must be module names, not files'));
    exportName[0].toUpperCase() !== exportName[0] && foundErrors.push(createFileDiagnostic(packageJSONPath, msg + 'Exports must be module names - capitalized leading chars.'));
    basenameBase === lowerBase(packageResource.packageName) &&
      foundErrors.push(createFileDiagnostic(packageJSONPath, msg + 'Cannot export the same module name as the package name:' + exportName));
  });

  var extensions = packageResource.packageJSON.CommonML.extensions;
  if (CommonML.extensions) {
    for (var i = 0; i < extensions && extensions.length; i++) {
      var extension = extensions[i];
      !(extension['interface'] && extension['implementation']) &&
        foundErrors.push(createFileDiagnostic(packageJSONPath, packageName + ' has misformed extensions'));
      !(extension['interface'].charAt(0) === '.' && extension['implementation'].charAt(0) === '.') &&
        packageName + ' has extensions that do not start with a (.) - ' +
        'extensions should look like [{"intf": ".blai", "impl": ".bla"}]';
    }
  }
  var subpackageNames = packageResource.subpackageNames;
  for (var i = 0; i < subpackageNames.length; i++) {
    var subpackageName = subpackageNames[i];
    var subpackage = resourceCache[subpackageName];
    if(packageJSON.dependencies && !packageJSON.dependencies[subpackageName]) {
      foundErrors.push(createFileDiagnostic(
        packageJSONPath,
        'Package named "' + subpackageName + '" was found in ' + packageName +
          '\'s node_module directory, but ' + packageName + ' doesn\'t depend on ' + subpackageName +
          ': \n\n' +
          '  1. Either edit ' + packageJSONPath + ' to include ' +
          subpackageName + ' as a dependency.\n'  +
          '  2. Or remove/unlink the package named ' + subpackageName +
          ' inside ' + path.join(realPath, 'node_modules') + ' .'
      ));
    }
  }

  // package.json lists it as a "dependency"
  for (var commonMLDependencyName in packageJSON.dependencies) {
    // Yet the CommonML dependency analyzer did not pick it up as a dependency.
    if (commonMLDependencyName !== 'CommonML' && subpackageNames.indexOf(commonMLDependencyName) === -1) {
      // This could be because it either doesn't exist, or it exists but is not a CommonML dependency.
      var exists = directoryExistsSync(path.join(path.join(realPath, 'node_modules'), commonMLDependencyName));
      var isNotACommonMLDependency = !exists;
      if (isNotACommonMLDependency) {
        foundErrors.push(createFileDiagnostic(
          packageJSONPath,
          packageName + ' depends on ' + commonMLDependencyName + ' but ' + commonMLDependencyName +
          ' isn\'t installed in '+ path.join(realPath, 'node_modules') + ':\n\n' +
          '  1. Either run npm install (or npm link ' + commonMLDependencyName + ') from within ' + realPath + '.\n' +
          '  2. Or remove ' + commonMLDependencyName + ' as a dependency of ' + packageName + ' by editing ' + packageJSONPath
        ));
      }
    }
  }
  return foundErrors;
};

var generateDotMerlinForPackage = function(resourceCache, autogenAliases, moduleArtifacts, rootPackageName, packageName ) {
  var packageConfig = resourceCache[packageName];
  var rootPackageConfig = resourceCache[rootPackageName];
  var commonML = packageConfig.packageJSON.CommonML;
  var linkFlags = commonML.linkFlags;
  var compileFlags = commonML.compileFlags || [];
  var findlibPackages = commonML.findlibPackages;
  var tags = commonML.tags;
  var buildTags = !tags ? '' : tags.map(function(tg) {return 'B +' + tg;});
  var pkgs = (findlibPackages || []).map(function(pk) {
    return pk.dependency ? ('PKG ' + pk.dependency) : '';
  });
  var filteredCompilerFlags = compileFlags.filter(function(f) {
    return f !== '-i' && f !== '-g' && f !== '-bin-annot'; // This screws up merlin
  });
  var flgs = ['FLG ' + filteredCompilerFlags.join(' ') + ' -open ' + autogenAliases.internalModuleName];

  // Suffix extensions. Merlin should have a flag that helps :MerlinLocate commands.
  var packageExtensions = packageConfig.packageJSON.CommonML.extensions;
  var extensions = [];
  if (packageExtensions) {
    for (var i = 0; i < packageExtensions.length; i++) {
      var extension = packageExtensions[i];
      var impl = extension['implementation'];
      var intf = extension['interface'];
      var implTrimmed = impl.trim();
      var intfTrimmed = intf.trim();
      if (implTrimmed && intfTrimmed) {
        extensions.push('SUFFIX ' + impl.trim() + ' ' + intf.trim());
      } else {
        extensions.push("# Invalid suffixes in package.json's CommonML")
      }
    }
  }

  var depSourceDirs = [];
  for (var i = 0; i < packageConfig.subpackageNames.length; i++) {
    var subpackageName = packageConfig.subpackageNames[i];
    var subpackage = resourceCache[subpackageName];
    // This messes merlin up because two different projects can have the same
    // module name (when packed). Once that is resolved this should work.
    // https://github.com/the-lambda-church/merlin/issues/284
    // Otherwise this will work
    var depPublicSourceDirs = getPublicSourceDirs(subpackage.packageResources.sourceFiles, subpackage);
    depSourceDirs.push.apply(depSourceDirs, depPublicSourceDirs);
  }
  var merlinBuildDirs =
    getSanitizedBuildDirs(packageConfig, rootPackageConfig, buildConfig)
    .concat(sanitizedImmediateDependenciesPublicPaths(resourceCache, packageConfig, rootPackageConfig, buildConfig));
  // For now, we build right where we have source files
  var buildLines = merlinBuildDirs.map(function(src) {return 'B ' + src;});
  var merlinSourceDirs =
    packageConfig.packageResources.directories
    .concat(depSourceDirs);
  var sourceLines = merlinSourceDirs.map(function(src) {return 'S ' + src;});
  var dotMerlinSource = sourceLines.concat(buildLines)
  .concat(buildTags)
  .concat(pkgs)
  .concat(flgs)
  .concat(extensions)
  .join('\n');
  return dotMerlinSource;
};

var repeat = function(times, char) {
  var ret = '';
  for (var i = 0; i < times; i++) {
    ret += char;
  }
  return ret;
};
var boxMsg = function(txt) {
  var lines = repeat(txt.length, '-');
  return [
    'echo "\n\n+' + lines + '+"',
    'echo "|' + txt + '|"',
    'echo "+' + lines + '+"'
  ].join('\n');
};

var box = function(txt) {
  var lines = repeat(txt.length, '-');
  return [
    '+' + lines + '+',
    '|' + txt + '|',
    '+' + lines + '+'
  ].join('\r\n');
};

var ocbFlagsForPackageCommand = function(command) {
  var dep = command.dependency;
  var syntax = command.syntax;
  if (syntax) {
    return ['-package', syntax, '-syntax', 'camlp4o'].join(' ');
  } else if (dep) {
    return ['-package', dep].join(' ');
  } else {
    invariant(
      false,
      'Findlib package has neither "dependency" nor "syntax" fields'
    );
  }
};

/**
 * using `ocamlfind` required that we first copy everything over into a _build
 * directory because it couldn't handle multiple -o flags. Turns out it's a
 * pretty good idea anyway. If you don't supply `-linkpkg` nothing works when
 * it comes time to link.
 */
var getFindlibCommand = function(packageResource, toolchainCommand, linkPkg) {
  var commonML = packageResource.packageJSON.CommonML;
  var findlibPackages = commonML.findlibPackages;
  var hasFindlibPackages = findlibPackages && findlibPackages.length;
  var findlibBuildCommand = OCAMLFIND + ' ' + toolchainCommand;
  // It appears that using findlib is *faster* than not using it - but if you
  // add several packages, then it's slower.
  var findlibFlags =
    hasFindlibPackages ?
    findlibPackages.map(ocbFlagsForPackageCommand).join(' ') :
    '';

  var findLib = [findlibBuildCommand, linkPkg ? '-linkpkg' : '', findlibFlags, '-only-show'].join(' ');

  // Trimming off the white space is critical, since this will usually return a
  // trailing newline which makes the command unusable
  return child_process.execSync(findLib).toString().trim();

};


/**
 * TODO: Get the actual graph, not just the topological ordering. That way we
 * compile the minimal set of changes needed.
 * Also, for cross project dependencies, we only need to recompile .ml files
 * that depend on changes to `.mli` files whether those changes to `.mli` files
 * be in the same project or another project.
 * Getting the graph is very easy: Just change the `ocamldep` command to be
 * -all -one-line and remove -sort.
 * It will tell you which files depend on which modules within your project.
 * Some work could be done to make it also tell you which files in your project
 * depend on which of your dependencies. Then you could combine that
 * information with the modified time of *interface* files.
 */
var getFilesNeedingRecompilation = function(dependencyResults, prevResultsCache, resourceCache, prevResourceCache, packageName) {
  var lastSuccessfulPackageResource =
    prevResultsCache.versionedResultsByPackageName[packageName] ?
    prevResultsCache.versionedResultsByPackageName[packageName].lastSuccessfulPackageResource : null;
  var buildOrdering = dependencyResults;
  var packageResource = resourceCache[packageName];
  if (!lastSuccessfulPackageResource) {
    return buildOrdering;
  }
  var prevSourceFiles = lastSuccessfulPackageResource.packageResources.sourceFiles;
  var prevSourceFileMTimes = lastSuccessfulPackageResource.packageResources.sourceFileMTimes;
  var nextSourceFiles = packageResource.packageResources.sourceFiles;
  var nextSourceFileMTimes = packageResource.packageResources.sourceFileMTimes;

  // d represents the first index where we found something different.  By the
  // end of loop, d will be at most the length of array (because of the last
  // d++).
  var firstChangedIndex = -1;
  for (var d = 0; d < buildOrdering.length; d++) {
    var absPath = buildOrdering[d];
    var indexInPreviousSourceFiles = prevSourceFiles.indexOf(absPath);
    var indexInNextSourceFiles = nextSourceFiles.indexOf(absPath);
    var nextMTime = nextSourceFileMTimes[indexInNextSourceFiles];
    if (indexInPreviousSourceFiles === -1) {
      firstChangedIndex = d;
      break;
    } else {
      invariant(indexInNextSourceFiles !== -1, 'Cannot find ocamldep supplied source ' + absPath);
      var prevMTime = prevSourceFileMTimes[indexInPreviousSourceFiles];
      if (prevMTime !== nextMTime) {
        firstChangedIndex = d;
        break;
      }
    }
  }
  if (firstChangedIndex === -1) {
    return buildOrdering;
  } else {
    return buildOrdering.slice(d);
  }
};

/**
 * Works best when `fileNames` is a short list.
 */
var newOrChangedFiles = function(extension, previousFiles, previousMTimes, nextFiles, nextFileMTimes) {
  var ret = [];
  for (var next = 0; next < nextFiles.length; next++) {
    var nextFile = nextFiles[next];
    // If it has the extension we care about.
    if (path.extname(nextFile) === extension) {
      var indexInPrevious = previousFiles.indexOf(nextFile);
      // It's a new file
      if (indexInPrevious === -1) {
        ret.push(nextFile);
      } else {
        if (previousMTimes[indexInPrevious] < nextFileMTimes[next]) {
          ret.push(nextFile);
        }
      }
    }
  }
  return ret;
};

/**
 * Returns the ordered set of `mly`, `mll` files that must be recompiled. A
 * simple heuristic stems from the fact that:
 * - `mll` files depend on `mly`.
 * - There is typically only one `mly`/`mll` file per project (except in case
 *   on Menhir - TODO: Support that).
 * - It's reasonable to simply recompile all of the `mll`s if any `mly`
 *   changed.
 */
var getLexYaccFilesRequiringRecompilation = function(resourceCache, prevResourceCache, packageName) {
  var prevCachedResource = prevResourceCache[packageName];
  var cachedResource = resourceCache[packageName];
  var previousSourceFiles = prevCachedResource ?
    prevCachedResource.packageResources.sourceFiles :
    [];
  var previousSourceFileMTimes = prevCachedResource ?
    prevCachedResource.packageResources.sourceFileMTimes :
    [];
  var nextSourceFiles = cachedResource.packageResources.sourceFiles;
  var nextSourceFileMTimes = cachedResource.packageResources.sourceFileMTimes;
  return {
    lex: newOrChangedFiles(
      '.mll',
      previousSourceFiles,
      previousSourceFileMTimes,
      nextSourceFiles,
      nextSourceFileMTimes
    ),
    yacc: newOrChangedFiles(
      '.mly',
      previousSourceFiles,
      previousSourceFileMTimes,
      nextSourceFiles,
      nextSourceFileMTimes
    )
  };
};


var sanitizedImmediateDependenciesPublicPaths = function(resourceCache, packageConfig, rootPackageConfig, buildConfig) {
  var immediateDependenciesPublicDirs = [];
  var subpackageNames = packageConfig.subpackageNames;
  for (var i = 0; i < subpackageNames.length; i++) {
    var subpackageName = subpackageNames[i];
    var subpackage = resourceCache[subpackageName];
    immediateDependenciesPublicDirs.push.apply(
      immediateDependenciesPublicDirs,
      getPublicSanitizedBuildDirs(subpackage, rootPackageConfig, buildConfig)
    );
  }
  return immediateDependenciesPublicDirs;
};

/**
 * Flags for compiling (but not linking).
 */
var getSingleFileCompileFlags = function(packageConfig, buildConfig, annot, buildLib) {
  var compileFlags = packageConfig.packageJSON.CommonML.compileFlags || [];
  var preprocessor = packageConfig.packageJSON.CommonML.preprocessor;
  return compileFlags.concat([
    buildLib ? '-a' : '-c',
    annot ? '-bin-annot' : '',
    buildConfig.forDebug ? '-g' : '',
    preprocessor ? '-pp ' + preprocessor : ''
  ]);
};


var getOCamldepFlags = function(packageConfig) {
  var extensions = packageConfig.packageJSON.CommonML.extensions;
  var extensionFlags = !extensions ? [] : extensions.map(function(exn) {
    return " -ml-synonym " + exn['implementation'] + " -mli-synonym " + exn['interface'] + ' ';
  });
  // The packageConfig's sourceFiles contains all files in `src` since it wasn't possible to know how to filter out non-source files until the package.json was found and parsed as part of the same source scanning process.
  var sourceFileArgs = packageConfig.packageResources.sourceFiles.map(function(sourceFile) {
    if (!isSourceFile(sourceFile, packageConfig)) {
      return '';
    }
    var kind = maybeSourceKind(sourceFile, packageConfig);
    // Be careful to not include e.g. .mll .mly files
    if (kind === '.ml') {
      return ' -impl ' + sourceFile;
    } else if (kind === '.mli') {
      return ' -intf ' + sourceFile;
    } else {
      // XXX: Should perhaps have a better handler for this.
      return '';
    }
  });
  var ppFlags = packageConfig.packageJSON.CommonML.preprocessor ? [
    '-pp ' + packageConfig.packageJSON.CommonML.preprocessor
  ] : [];

  return ['-sort', '-one-line']
    .concat(extensionFlags)
    .concat(ppFlags)
    .concat(sourceFileArgs);
};

function directoryExistsSync(absDir) {
  return fs.existsSync(absDir) && fs.statSync(absDir).isDirectory();
}

function upperBase(fileName) {
  return fileName[0].toUpperCase() + fileName.substr(1);
}
function lowerBase(fileName) {
  return fileName[0].toLowerCase() + fileName.substr(1);
}

// Uses mutation.
function getPackageResources(absRootDir, directories, sourceFiles, sourceFileMTimes) {
  var dirList = fs.readdirSync(absRootDir);
  dirList.forEach(function(fileName) {
    var absPath = path.join(absRootDir, fileName);
    var stats = fs.statSync(absPath);
    if (stats.isDirectory()) {
      var dirRealPath = fs.realpathSync(absPath);
      invariant(absPath === dirRealPath, [
        'Symlinks not supported in src',
        absPath,
        dirRealPath
      ].join(' '));
      directories.push(absPath);
      getPackageResources(absPath, directories, sourceFiles, sourceFileMTimes);
    } else if (true /*isSourceFile(absPath, packageConfig */) {
      // No way to check source file until package config loaded and extensions
      // are analyzed.
      sourceFiles.push(absPath);
      sourceFileMTimes.push(stats.mtime.getTime());
    }
  });
}

function getPackageResourcesForRoot(absDir) {
  var sourceDir = path.join(absDir, 'src');
  var directories = [];
  var sourceFiles = [];
  var sourceFileMTimes = [];

  if (!directoryExistsSync(sourceDir)) {
    logError('Does not appear to be a CommonML package with `src` directory:' + absDir);
  } else {
    getPackageResources(sourceDir, directories, sourceFiles, sourceFileMTimes);
  }
  return {
    directories: directories,
    sourceFiles: sourceFiles,
    sourceFileMTimes: sourceFileMTimes,
  };
}

function getPackageJSONForPackage(absDir) {
  var dirList = fs.readdirSync(absDir);
  if (dirList.indexOf('package.json') !== -1) {
    var jsonPath = path.join(absDir, 'package.json');
    var packageContents = fs.readFileSync(jsonPath);
    try {
      return JSON.parse(packageContents);
    } catch (e) {
      throw new Error(
        'Invalid ' + jsonPath +
        '.\n Some common mistakes to check: \n' +
        ' - no single quotes, only double.\n' +
        ' - no trailing commas.\n'
      );
    }
  } else {
    logError('No package.json file for package at ' + absDir);
  }
}

/**
 * Pass in a `node_modules` directory.
 */
function getSubprojectPackageDescriptors(nodeModulesDir) {
  var ret = {};
  var exists = fs.existsSync(nodeModulesDir);
  if (!exists) {
    return ret;
  }
  var dirList = fs.readdirSync(nodeModulesDir);
  for (var i = 0; i < dirList.length; i++) {
    var packageName = dirList[i];
    var fullPath = path.join(nodeModulesDir, packageName);
    var realPath = fs.realpathSync(fullPath);
    if (fs.statSync(realPath).isDirectory()) {
      var packageJSON = getPackageJSONForPackage(realPath);
      if (packageJSON) {
        var nameField = packageJSON.name;
        if ((packageJSON.CommonML  || packageJSON.commonml || packageJSON.commonML || packageJSON.CommonMl) &&
            packageName !== 'CommonML') {
          if (!nameField) {
            throw new Error("Cannot find `name` field in package.json for " +  fullPath);
          }
          if (nameField !== packageName) {
            throw new Error("packageName and directory are different - this is fine. Delete this error. " +  fullPath);
          }
          ret = ret || {};
          ret[nameField] = {
            realPath: realPath,
            packageJSON: packageJSON
          };
        }
      }
    }
  }
  return ret;
}

function recordPackageResourceCache(resourceCache, currentlyVisitingByPackageName, absRootDir) {
  var packageJSON = getPackageJSONForPackage(absRootDir);
  var rootPackageName = packageJSON.name;
  var foundPackageInvalidations = [];
  var foundPackageJSONInvalidations = verifyPackageJSONFile(rootPackageName, absRootDir, packageJSON);
  if (foundPackageJSONInvalidations.length !== 0) {
    return foundPackageJSONInvalidations;
  } else {
    currentlyVisitingByPackageName[rootPackageName] = true;
    var subprojectDir = path.join(absRootDir, 'node_modules');
    var subdescriptors = getSubprojectPackageDescriptors(subprojectDir);
    var subpackageNames = [];
    for (var subpackageName in subdescriptors) {
      var subdescriptor = subdescriptors[subpackageName];
      if (!resourceCache[subpackageName]) {
        if (currentlyVisitingByPackageName[subpackageName]) {
          var msg = (
            'Circular dependency was detected from package ' +
              rootPackageName + ' (' + absRootDir + ')' +
              subdescriptor.realPath + ' to ' + absRootDir
          );
          // Don't recurse because inifinity
          foundPackageInvalidations = foundPackageInvalidations.concat([createFileDiagnostic(absRootDir, msg)]);
        } else {
          foundPackageInvalidations =
            foundPackageInvalidations.concat(
              recordPackageResourceCache(resourceCache, currentlyVisitingByPackageName, subdescriptor.realPath)
            );
        }
      }
      subpackageNames.push(subpackageName);
    }
    resourceCache[rootPackageName] = {
      packageName: rootPackageName,
      packageResources: getPackageResourcesForRoot(absRootDir),
      realPath: absRootDir,
      packageJSON: packageJSON,
      subpackageNames: subpackageNames
    };
    var thisPackageInvalidations = verifyPackageConfig(resourceCache[rootPackageName], resourceCache);
    foundPackageInvalidations = thisPackageInvalidations.length ? foundPackageInvalidations.concat(thisPackageInvalidations) : foundPackageInvalidations;
    currentlyVisitingByPackageName[subpackageName] = false;
    return foundPackageInvalidations;
  }
}

/**
 * Returns the top level package name.
 */
function recordPackageResourceCacheAndValidate(resourceCache, absRootDir) {
  var currentlyVisitingByPackageName = {};
  var foundPackageInvalidations =
    recordPackageResourceCache(resourceCache, currentlyVisitingByPackageName, absRootDir);
  var packageJSON = getPackageJSONForPackage(absRootDir);
  return {foundPackageInvalidations: foundPackageInvalidations, rootPackageName: packageJSON.name};
};


var executeScripts = function(scripts, outputSoFar, onFailTerminate, onDone, filterOutput) {
  if (scripts.length === 0) {
    onDone(outputSoFar);
  } else {
    var script = scripts[0];
    var onFailShouldContinue = script.onFailShouldContinue;
    var scriptLines = script.scriptLines;
    var description = script.description;
    invariant(
      scriptLines.length,
      'scriptLines should never be len zero:' + description
    );
    // execEachScript should join the stdout, stderr
    exec(scriptLines[0], function (error, stdout, stderr) {
      if (stdout) {
        log('[STDOUT]:\n', filterOutput ? filterOutput(stdout) : stdout, '\n');
      }
      if (stderr) {
        logError([
          '[STDERR]:',
          'Error executing build script:\n',
          scripts[0].description,
          scriptLines[0]
        ].join('\n'));
        logError('[STDERR]', filterOutput ? filterOutput(stderr) : stderr);
      }
      if (onFailShouldContinue || (!error && !stderr))  {
        var nextScripts = scriptLines.length > 1 ? [{
          description: script.description,
          onFailShouldContinue: onFailShouldContinue,
          scriptLines: scriptLines.slice(1)
        }].concat(scripts.slice(1)) : scripts.slice(1);
        executeScripts(nextScripts, outputSoFar + stdout, onFailTerminate, onDone, filterOutput);
      } else {
        log('Cannot recover from error - stopping the build.');
        onFailTerminate(stderr);
      }
    });
  }
};

var NodeErrorState = {
  Success: 'Success',
  SubnodeFail: 'SubnodeFail',
  NodeFail: 'NodeFail'
};

var cacheVersionedResultAndNotifyWaiters = function(resultsCache, packageName, versionedResult, waiters) {
  resultsCache.alreadyBeingBuiltWithWaiters[packageName] = null;
  resultsCache.versionedResultsByPackageName[packageName] = versionedResult;
  waiters.forEach(function(waiter) {
    waiter(null);
  });
};

var discoverDeps = function(resourceCache, packageName, onDone) {
  var packageResource = resourceCache[packageName];
  var packageResources = packageResource.packageResources;
  var findlibOCamldepCommand = getFindlibCommand(resourceCache[packageName], programForCompiler(OCAMLDEP), false);
  log('> Computing dependencies for ' + packageResource.packageName + '\n\n');
  var preprocessor = packageResource.packageJSON.CommonML.preprocessor;
  var cmd =
    [findlibOCamldepCommand]
    .concat(getOCamldepFlags(packageResource))
    .join(' ');
  log(cmd);
  var scripts = [{
    description: 'ocamldep script',
    scriptLines: [cmd],
    onFailShouldContinue: false
  }];
  var onOcamldepFail = function(e) {
    var dependencyResults = {
      commands: [cmd],
      successfulResults: null,
      err: e
    };
    onDone(dependencyResults);
  };
  var onOneOcamldepDone = function(oneOcamldepOutput) {
    var dependencyResults = {
      commands: [cmd],
      successfulResults: removeBreaks(oneOcamldepOutput).split(' ').filter(notEmptyString),
      err: null
    };
    onDone(dependencyResults);
  };
  executeScripts(scripts, '', onOcamldepFail, onOneOcamldepDone);
};

var chromeProgram =
  fs.existsSync('/Applications/Google\ Chrome\ Canary.app/Contents/MacOS/Google\ Chrome\ Canary') ?
    '/Applications/Google\\ Chrome\\ Canary.app/Contents/MacOS/Google\\ Chrome\\ Canary' :
  fs.existsSync('/Applications/Google\ Chrome.app/Contents/MacOS/Google\ Chrome') ?
    '/Applications/Google\\ Chrome.app/Contents/MacOS/Google\\ Chrome' : null;

var getEchoJsCommand = function(jsArtifact, dirToContainJsBuildDirSymlink) {
  var indexHtmlFile = 'file:\/\/' + dirToContainJsBuildDirSymlink + '\/index.html';
  var ret = [
    '',
    '#',
    '# JavaScript Package at: ' + jsArtifact,
    '# ======================================',
    '#',
    '# Running in a browser',
    '# --------------------',
    '# - Create an index html page (that includes script ./jsBuild/app.js) at :',
    '#',
    '#    ' + indexHtmlFile,
    '#',
    '# - To see source maps and to enable ajax requests to your local file system, ',
    '# open Chrome with the local file access flag --allow-file-access-from-files. ',
    '# Enable Chromes source maps in settings, open the debugger then *refresh*.',
    '#',
    !chromeProgram ? '#' : '#    ' + chromeProgram + ' --allow-file-access-from-files ' + indexHtmlFile,
    '#',
    '# - Optionally, serve using python and visit via the following URL (source maps wont work):',
    '#',
    '#    pushd ' + dirToContainJsBuildDirSymlink + ' && python -m SimpleHTTPServer || popd',
    '#    open http:\/\/localhost:8000\/index.html ',
    '# Test in JavaScriptCore',
    '# -----------------------',
    '#  /System/Library/Frameworks/JavaScriptCore.framework/Versions/Current/Resources/jsc -e "console = {log:print};" -f ' + jsArtifact,
    '#',
    ''
  ].join('\n');
  return ret;
};

// We could pass all of `ocamldepOrderedSourceFiles`, but that creates
// build artifacts. So we can supply all of the already built artifacts
// (in the _build) folder, but that won't accept .cmi's so we must only
// get the .cmos.
var getJustTheModuleArtifactsForAllPackages = function(rootPackageName, buildPackagesResultsCache, resourceCache) {
  var justTheModuleArtifacts = [];
  traversePackagesInOrder(resourceCache, rootPackageName, function(packageName) {
    var autogenAliases = buildPackagesResultsCache.versionedResultsByPackageName[packageName].results.computedData.autogenAliases;
    var packageResource = resourceCache[packageName];
    justTheModuleArtifacts.push(buildArtifact(autogenAliases.genSourceFiles.internalImplementation, buildConfig, packageResource));
    justTheModuleArtifacts.push.apply(
      justTheModuleArtifacts,
      getModuleArtifacts(
        buildPackagesResultsCache.versionedResultsByPackageName[packageName].results.dependencyResults.successfulResults,
        resourceCache[packageName],
        resourceCache[rootPackageName],
        buildConfig
      )
    );
  });

  return justTheModuleArtifacts;
};

var buildExecutable = function(rootPackageName, buildPackagesResultsCache, resourceCache, onDone) {
  var packageResource = resourceCache[rootPackageName];
  var executableArtifact = buildForExecutable(packageResource, packageResource, buildConfig);
  var findlibLinkCommand = getFindlibCommand(packageResource, programForCompiler(buildConfig.compiler), true);
  var allModuleArtifacts =
    getJustTheModuleArtifactsForAllPackages(rootPackageName, buildPackagesResultsCache, resourceCache);


  var usersModuleArtifacts = allModuleArtifacts
    .filter(function(v) {
      return v.indexOf(packageResource.packageName) > -1;
    });
  var justTheModuleArtifactsForDependencies = allModuleArtifacts
    .filter(function(v) {
      return v.indexOf(packageResource.packageName) === -1;
    })
    .map(function(v) {
      if (v.indexOf('privateInnerModules') > -1 || v.indexOf('publicInnerModules') > -1) {
        return v;
      }
      return v.replace('.cmo', '.cma');
    });
  var commonML = packageResource.packageJSON.CommonML;
  var linkFlags = commonML.linkFlags || [];
  var compileFlags = commonML.compileFlags || []; // TODO: Rename 'rootCompileFlags'
  var tags = commonML.tags;

  var compileExecutableCommand =
    [findlibLinkCommand]
    .concat(['-o', executableArtifact])
    .concat(buildConfig.forDebug ? ['-g'] : [])
    .concat(linkFlags)
    .concat(justTheModuleArtifactsForDependencies)
    .concat(usersModuleArtifacts)
    .join(' ');

  // Can only build the top level packages into JS - ideally we'd also be
  // able to dynamically link JS bundles..
  var shouldCompileExecutableIntoJS = !!buildConfig.jsCompile;
  var placeJsBuildDirInField = packageResource.packageJSON.CommonML.jsPlaceBuildArtifactsIn;
  var dirToContainJsBuildDirSymlink = placeJsBuildDirInField ? path.join(packageResource.realPath, placeJsBuildDirInField) : packageResource.realPath;
  var jsBuildDir = entireActualBuildDir(packageResource, buildConfig) + '_js';
  var byteCodeBuildDir = entireActualBuildDir(packageResource, buildConfig);
  var ensureJsBuildDirCommand = ['mkdir', '-p', jsBuildDir].join(' ');
  var jsArtifactRelativeForm = './app.js';
  var jsArtifact = shouldCompileExecutableIntoJS ? path.join(jsBuildDir, 'app.js') : null;

  var symlinkBuildDirCommands = shouldCompileExecutableIntoJS && createSymlinkCommands(
    path.join(dirToContainJsBuildDirSymlink, 'jsBuild'),
    jsBuildDir
  ).join('\n');

  // The cp command is such a broken API - there isn't a way to overwrite
  // an entire directory.
  // Change into the root directory so that source maps are w.r.t. correct location.
  var changeDir = shouldCompileExecutableIntoJS && ['cd', jsBuildDir ].join(' ');
  var buildJSArtifactCommand = shouldCompileExecutableIntoJS && [
    'js_of_ocaml',
    buildConfig.opt !== 1 ? '--opt ' + buildConfig.opt  : '',
    '--source-map',
    buildConfig.opt !== 3 ? '--no-inline' : '',
    '--debug-info',
    '--pretty',
    '--linkall',
    executableArtifact,
    '-o',
    jsArtifactRelativeForm
  ].join(' ');
  var echoJSMessage = getEchoJsCommand(jsArtifact, dirToContainJsBuildDirSymlink);
  var buildJSCommands = (
    shouldCompileExecutableIntoJS ? [
      ensureJsBuildDirCommand,
      changeDir,
      buildJSArtifactCommand,
      symlinkBuildDirCommands,
      echoJSMessage
    ] : []
  ).join('\n');

  var compileCommands = [compileExecutableCommand].concat(shouldCompileExecutableIntoJS ? [buildJSCommands] : []);

  var buildingExecMsg = "Compiling executable " + rootPackageName;
  var compileCmdMsg =
    [boxMsg(buildingExecMsg)]
    .concat(compileCommands.length === 0 ? [] : [
      'echo " > Compiler Toolchain:"',
      // having echo use single quotes doesn't destroy any of the quotes in
      // findlib commands
      "echo ' > " + compileCommands.join("\n> ") + "'"
    ]).join('\n');

  var buildScripts = [{
    description: 'Build Script For ' + packageResource.packageName,
    scriptLines: [compileCmdMsg].concat(compileCommands),
    onFailShouldContinue: false
  }];
  var onBuildFail = function(err) {
    var buildResults = {commands: [compileCmdMsg], successfulResults: null, err: err };
    var computedData = {executableArtifact: executableArtifact};
    onDone(buildResults, computedData);
  };
  var onBuildComplete = function(buildOutput) {
    var buildResults = {commands: [compileCmdMsg], successfulResults: buildOutput, err: null};
    var computedData = {
      executableArtifact: executableArtifact,
      jsExecutableArtifact: shouldCompileExecutableIntoJS && jsArtifact
    };
    onDone(buildResults, computedData);
  };
  executeScripts(buildScripts, '', onBuildFail, onBuildComplete);
};

var getSomeDependencyTriggeredRebuild = function(subpackageNames, resultsCache) {
  var someDependencyTriggeredRebuild = false;
  subpackageNames.forEach(function(subpackageName) {
    if (resultsCache.versionedResultsByPackageName[subpackageName].lastBuildIdEffectingDependents === resultsCache.currentBuildId) {
      someDependencyTriggeredRebuild = true;
    }
  });
  return someDependencyTriggeredRebuild;
};

/**
 * TODO: Minimal *inter* pacakge rebuilds: "Pure Interfaced" packages. If every
 * *publicly* marked module has an interface file, then in many cases, it can
 * be determined that package impl recompilations will not effect package
 * dependencies. (To do this right, we must have a *graph* of intra-module
 * dependencies). If triggering an internal rebuild does not require rebuilding
 * *any* public module's interface (which won't always be the case when
 * signatures "include" other modules). Could every interface be inferred and
 * therefore save compilation times for deeply depended on packages? (Kind of
 * like PureRenderMixin - it costs more per node to evaluate, but could pay off
 * by avoiding propagation to other modules.
 *
 * TODO: Minimal *intra* package rebuilds. The only practical way to achieve
 * minimal intra-package rebuilds, is to get the `ocamldep` graph output. It's
 * not as simple as finding changed mtimes of interfaces (explicit or
 * implicit). An interface myInterface.mli can `include OtherModule_Intf.S`, so
 * the myInterface.mli did not actually change. So the only way is to track
 * individual file dependencies within any single project. For better
 * dependency tracking, we can use compiler-libs to cache the type of interfact
 * files.
 *
 * TODO: Avoid the following when we're only rebuilding because a *downstream*
 * file changed:
 *
 * - Dependency analysis.
 * - Generating Alias files.
 * - Maybe even recompiling those alias files.
 * - Computing and generating .merlin files.
 *
 */
var dirtyDetectingBuilder = function(rootPackageName, resultsCache, prevResultsCache, resourceCache, prevResourceCache, packageName, onDirtyDetectingBuilderDone) {
  var packageResource = resourceCache[packageName];
  var rootPackageResource = resourceCache[rootPackageName];
  var lastSuccessfulPackageResource =
    prevResultsCache.versionedResultsByPackageName[packageName] ?
    prevResultsCache.versionedResultsByPackageName[packageName].lastSuccessfulPackageResource : null;
  var neverBeenSuccessfullyBuilt = !lastSuccessfulPackageResource;
  var subpackageNames = packageResource.subpackageNames;

  var someDependencyTriggeredRebuild = getSomeDependencyTriggeredRebuild(subpackageNames, resultsCache);
  // Can remove these since the builder itself will redo this logic and then
  // some to determine which *parts* of the build need to be performed.
  var mTimesChanged = getMTimesChanged(resourceCache[packageName], lastSuccessfulPackageResource, packageName);
  var fileSetChanged = getFileSetChanged(resourceCache[packageName], lastSuccessfulPackageResource, packageName);
  var buildConfigMightChangeCompilation = getBuildConfigMightChangeCompilation(resultsCache.buildConfig, prevResultsCache.buildConfig);
  var commonMLChanged = getCommonMLChanged(resourceCache[packageName], lastSuccessfulPackageResource, packageName);
  var configurationChanged = buildConfigMightChangeCompilation || commonMLChanged;
  var somethingInThisProjectChanged =
    mTimesChanged || fileSetChanged ||
    configurationChanged;
  var needsReevaluateDeps =
    somethingInThisProjectChanged ||
    // Either don't have dependency results.
    !prevResultsCache.versionedResultsByPackageName[packageName].results.dependencyResults ||
    // Or they were empty
    !prevResultsCache.versionedResultsByPackageName[packageName].results.dependencyResults.successfulResults;

  var buildFromDependencies = function(dependencyResults) {
    var dependencySuccessfulResults = dependencyResults.successfulResults;
    var commonML = packageResource.packageJSON.CommonML;
    validateFlags(commonML.compileFlags, commonML.linkFlags, packageName);
    // If any new file was added, we have to regenerate the autogenerated aliases
    // files and recompile them. This means we have to recompile *everything* in
    // the project. We cannot just recompile the aliases files, and the newly
    // added/changed modules because when it comes time to link them all
    // together, the older compilations will have "inconsistent interface"s
    // w.r.t. to autogenerated aliases.  We also make sure to *not*
    // recompile/generate the aliases when no new module has been added.
    var needsRecompileAllModules = configurationChanged || fileSetChanged;

    // Same condition as above
    var needsRegenerateCompileAliases = configurationChanged || fileSetChanged;
    var needsRegenerateDotMerlin = configurationChanged || fileSetChanged;
    var sourceFilesToRecompile =
      needsRecompileAllModules ? dependencySuccessfulResults :
      getFilesNeedingRecompilation(dependencySuccessfulResults, prevResultsCache, resourceCache, prevResourceCache, packageName);
    var needsModuleRecompiles = sourceFilesToRecompile.length > 0;
    var fileOutputDirs = getSanitizedBuildDirs(packageResource, rootPackageResource, buildConfig);

    // Compiling alias files for public/internal consumption of this module.
    var autogenAliases = autogenAliasesCommand(
      dependencySuccessfulResults,
      packageResource,
      rootPackageResource,
      buildConfig
    );

    var searchPaths = makeSearchPathStrings(
      fileOutputDirs
      .concat(sanitizedImmediateDependenciesPublicPaths(resourceCache, packageResource, rootPackageResource, buildConfig))
    );

    var compileCommand =
      getFindlibCommand(packageResource, programForCompiler(buildConfig.compiler), false);

    var singleFileCompile =
      [compileCommand]
      .concat(getSingleFileCompileFlags(packageResource, buildConfig, true, false))
      .concat(searchPaths)
      .concat(['-open', autogenAliases.internalModuleName]).join(' ') + ' ';

    // The performance of this will be horrible if using ocamlfind with custom
    // packages - it takes a long time to look those up, and we do it for every
    // file! In the future, cache the result of the findlib command.
    var compileModuleOutputs =
      getNamespacedFileOutputCommands(sourceFilesToRecompile, packageResource, rootPackageResource, buildConfig);
    var compileModulesCommands =
      singleFileCompile + compileModuleOutputs.map( function(c){return c.compileOutputString;}).join(' ');

    // Always repack regardless of what changed it's pretty cheap.
    var compileAliasesCommand =
      [compileCommand]
      .concat(getSingleFileCompileFlags(packageResource, buildConfig, true, true))
      // -bin-annot generates .cmt files for the pack which merlin needs to
      // work correctly.
      // Need to add -49 so that it doesn't complain because we haven't
      // actually compiled the namespaced modules yet. They are like forward
      // declarations in that sense.
      .concat(['-no-alias-deps -w -49'])
      .concat(searchPaths)
      .concat([
        autogenAliases.genSourceFiles.internalInterface,
        autogenAliases.genSourceFiles.internalImplementation,
      ])
      .concat(commonML.linkFlags)
      // Used only for C dependencies currently. Should be only _already_ built
      // files.
      .concat(commonML.foreignDependencies && commonML.foreignDependencies.length > 0
        ? ['-custom'].concat(commonML.foreignDependencies.map(function(v){ return path.join(packageResource.realPath, v); }))
        : [])
      .concat(['-o', autogenAliases.genSourceFiles.internalImplementation.replace('.ml', '.cma')])
      .join(' ');
    var ensureDirectoriesCommand = ['mkdir', '-p', ].concat(fileOutputDirs).join(' ');
    var justTheModuleArtifacts =
      getModuleArtifacts(dependencySuccessfulResults, packageResource, rootPackageResource, buildConfig);
    var compileCommands =
      (needsRegenerateCompileAliases ? [compileAliasesCommand] : [])
      .concat(someDependencyTriggeredRebuild || needsModuleRecompiles ? [compileModulesCommands] : []);

    var compileModulesMsg =
      sourceFilesToRecompile.length === 0 ?
        'echo " > No files need recompilation, packing in ' + packageResource.packageName +
        (somethingInThisProjectChanged ? '. Will link if root package.' : '. Will not link.') + '"' :
      sourceFilesToRecompile.length < dependencySuccessfulResults.length ?
        'echo " > Incrementally recompiling, packing and (if needed) linking ' + packageName +
        ' modules [ ' + sourceFilesToRecompile.join(' ') + ' ]"' : '';

    // Already built this dependency
    var buildingLibraryMsg = 'Building library ' + packageName;
    var compileCmdMsg =
      [boxMsg(buildingLibraryMsg), compileModulesMsg]
      .concat(compileCommands.length === 0 ? [] : [
        'echo " > Compiler Toolchain:"',
        // having echo use single quotes doesn't destroy any of the quotes in
        // findlib commands
        "echo ' > " + compileCommands.join("\n> ") + "'"
      ]).join('\n');

    if (needsRegenerateDotMerlin) {
      var merlinPath = path.join(packageResource.realPath, '.merlin');
      var merlinCommand = [
        'echo " > Autocomplete .merlin file for ' + merlinPath + ':"',
        'echo "',
        generateDotMerlinForPackage(resourceCache, autogenAliases, justTheModuleArtifacts, rootPackageName, packageName),
        '" > ' + merlinPath,
      ].join('\n');
    }

    var buildScriptForThisPackage = [];
    buildScriptForThisPackage.push(ensureDirectoriesCommand);
    // Only regenerate/build the aliases modules if the file set changed.
    // (recall earlier in this file we ensured that when this happen we perform
    // a full recompilation of the project to prevent "inconsistent interfaces"
    // errors).
    needsRegenerateCompileAliases && buildScriptForThisPackage.push(autogenAliases.generateCommands);
    // Build merlin before so that even if the package build fails, at least
    // the prior packages' builds will benefit editing the currently failing
    // package.
    needsRegenerateDotMerlin && buildScriptForThisPackage.push(merlinCommand);
    buildScriptForThisPackage.push(compileCmdMsg);
    buildScriptForThisPackage.push.apply(buildScriptForThisPackage, compileCommands);
    var buildScripts = [{
      description: 'Build Script For ' + packageResource.packageName,
      scriptLines: buildScriptForThisPackage,
      onFailShouldContinue: false
    }];
    var onBuildFail = function(err) {
      var buildResults = {commands: buildScriptForThisPackage, successfulResults: null, err: err };
      var computedData = {};
      onDirtyDetectingBuilderDone(dependencyResults, buildResults, computedData, true, true);
    };
    var onBuildComplete = function(buildOutput) {
      var buildResults = {commands: buildScriptForThisPackage, successfulResults: buildOutput, err: null};
      var computedData = {autogenAliases: autogenAliases};
      onDirtyDetectingBuilderDone(dependencyResults, buildResults, computedData, true, true);
    };
    executeScripts(buildScripts, '', onBuildFail, onBuildComplete);
  };

  /**
   * Now that that huge function is defined, do the real magic.
   */
  if (needsReevaluateDeps) {
    var onDepsDiscoveryDone = function(dependencyResults) {
      if (dependencyResults.err) {
        onDirtyDetectingBuilderDone(dependencyResults, {commands: null, successfulResults: null, err: null}, {}, true, true);
      } else {
        buildFromDependencies(dependencyResults);
      }
    };
    discoverDeps(resourceCache, packageName, onDepsDiscoveryDone);
  } else if (someDependencyTriggeredRebuild) {
    // Can skip internal dependency evaluation if we are *only* building
    // because a dependency was rebuilt (yet we have no internal file changes).
    // TODO: Can also skip merlin generation and alias generation!
    var previousDependencyResults = prevResultsCache.versionedResultsByPackageName[packageName].results.dependencyResults;
    buildFromDependencies(previousDependencyResults);
  } else {
    var prevResults = prevResultsCache.versionedResultsByPackageName[packageName].results;
    onDirtyDetectingBuilderDone(prevResults.dependencyResults, prevResults.buildResults, prevResults.computedData, false, false);
  }
};


/**
 * Incremental building is merely just priming the results cache.  A
 * preprocessing step determines which results couldnt possibly be effected by
 * mtime changes.
 *
 * `resultsCache` has shape: {
 *     currentBuildId: number,
 *     buildConfig: (build config for currentBuildId),
 *     alreadyBeingBuiltWithWaiters: [err => ],
 *     versionedResultsByPackageName: {
 *
 *       // buildId that the package was last *checked* and either successfully
 *       // cleaned or failed. After each build, every package gets the
 *       // `currentBuildId` whether or not it succeeds cleaning.
 *       lastAttemptedBuildId: number,
 *
 *       // buildId that the package was last deemed sufficiently "cleaned".
 *       // Every successfully built package gets the `lastSuccessfulBuildId` = `currentBuildId`.
 *       lastSuccessfulBuildId: number,
 *       lastSuccessfulPackageResource: packageResource,  (last project file set that succeeded)
 *
 *       // Last buildId that successfully produced artifacts - that effects
 *       // the whole project (linking etc). Always older or equal to `lastSuccessfulBuildId`.
 *       lastBuildIdEffectingProject: number,
 *
 *       Last buildId that will effect dependents compilation. Usually
 *       paired with lastBuildIdEffectingProject.
 *       lastBuildIdEffectingDependents: number,
 *       results: {
 *         errorState: Success | SubnodeFail | NodeFail,
 *         erroredSubpackages: [string],
 *
 *         TODO: Just make these an opaque array with
 *         commands/successfulResults/err, that can be "replayed". For anything
 *         that needs to be structured/modeled, use `computedData`.
 *         Question: But then how do seconds stages know that they can reuse
 *         the "zeroth position" in the previous results cache? I suppose that
 *         can go in `computedData`.
 *         dependencyResults: {
 *           commands: [string],
 *           successfulResults: string || null,
 *           err: * || null
 *         },
 *         buildResults: {
 *           commands: [string],
 *           successfulResults: string || null,
 *           err: * || null,
 *         },
 *         computedData: *,
 *
 *       }
 *     }
 *  }
 *
 *  Nothing changed, and package marked up to date, nothing changed about what
 *  needs to be relinked on account of *this* package.
 *
 *      lastAttemptedBuildId: 1
 *      lastSuccessfulBuildId: 1,
 *      lastBuildIdEffectingProject: 0
 *      lastBuildIdEffectingDependents: 0
 *      lastSuccessfulBuildId: 1
 *
 *  Package rebuilt, dependencies needn't be rebuilt, whole project must be rebuilt (linked).
 *
 *      lastAttemptedBuildId: 1
 *      lastSuccessfulBuildId: 1,
 *      lastBuildIdEffectingProject: 1
 *      lastBuildIdEffectingDependents: 0
 *      lastSuccessfulBuildId: 1
 *
 *  Package rebuilt and dependencies need to be rebuilt, but whole program
 *  neendn't be linked (this is likely not a valid configuration).
 *
 *      lastAttemptedBuildId: 1
 *      lastSuccessfulBuildId: 1,
 *      lastBuildIdEffectingProject: 0
 *      lastBuildIdEffectingDependents: 1
 *      lastSuccessfulBuildId: 1
 *
 *  This is the most common form when a project recompiles new versions of artifacts.
 *
 *      lastAttemptedBuildId: 1
 *      lastSuccessfulBuildId: 1,
 *      lastBuildIdEffectingProject: 1
 *      lastBuildIdEffectingDependents: 1
 *      lastSuccessfulBuildId: 1
 *
 *  Tried to compile the project, but was not successful.
 *
 *      lastAttemptedBuildId: 2
 *      lastSuccessfulBuildId: 1,
 *      lastBuildIdEffectingProject: anything
 *      lastBuildIdEffectingDependents: anything
 *      lastSuccessfulBuildId: anything
 *
 *
 * `dirtyDetectingBuilder(rootPackageName, resultsCache, prevResultsCache, resourceCache, prevResourceCache, packageName, function(dependencyResults, buildResults, computedData, effectWholeProject, effectDependents) {})`
 * `mapper(root, subpackagesResults, function(err, mapperResult) {})`
 */
var walkProjectTree = function(rootPackageName, resultsCache, prevResultsCache, resourceCache, prevResourceCache, dirtyDetectingBuilder, packageName, onRootDone) {
  // If it's either WIP by another node, or done.
  var currentBuildId = resultsCache.currentBuildId;
  var alreadyBeingBuilt = resultsCache.alreadyBeingBuiltWithWaiters[packageName];
  if (alreadyBeingBuilt) {
    resultsCache.alreadyBeingBuiltWithWaiters[packageName].push(onRootDone);
  } else {
    var mostRecent =
      // It could have already been built by this build process.
      resultsCache.versionedResultsByPackageName[packageName] ||
      // Or a prior build process, if not by this build process (short circuit is important here).
      prevResultsCache.versionedResultsByPackageName[packageName];

    // The most recent attempt to build occured in *this* build. Nothing more
    // to do. If it succeeded, great - the cache is updated. If not, trying
    // again won't help!
    if (mostRecent && currentBuildId === mostRecent.lastAttemptedBuildId) {
      onRootDone(null);
    } else {
      resultsCache.alreadyBeingBuiltWithWaiters[packageName] = [];
      if (!mostRecent) {
        mostRecent = {
          lastAttemptedBuildId: -1,
          lastSuccessfulBuildId: -1,
          lastSuccessfulPackageResource: null,
          lastBuildIdEffectingProject: -1,
          lastBuildIdEffectingDependents: -1,
          results: null
        };
        resultsCache.versionedResultsByPackageName[packageName] = mostRecent;
      }
      var preBuild = resultsCache.versionedResultsByPackageName[packageName];
      // Abstracts away *everything* about the form of the resource cache and
      // Build steps!
      var subpackageNames = resourceCache[packageName].subpackageNames;
      var forEachSubpackage = function(subpackageName, onSubpackageDone) {
        walkProjectTree(rootPackageName, resultsCache, prevResultsCache, resourceCache, prevResourceCache, dirtyDetectingBuilder, subpackageName, onSubpackageDone);
      };
      var onAllSubpackagesDone = function(err) {
        var waiters = resultsCache.alreadyBeingBuiltWithWaiters[packageName];
        // Shouldn't happen. Errors should be encoded in results.
        if (err) {
          throw new Error(err);
        }
        var errorDependencies = [];
        subpackageNames.forEach(function(depName) {
          var curDependencyResult = resultsCache.versionedResultsByPackageName[depName].results;
          if (curDependencyResult.errorState === NodeErrorState.SubnodeFail ||
              curDependencyResult.errorState === NodeErrorState.NodeFail) {
            errorDependencies.push(depName);
          }
        });
        if (errorDependencies.length) {
          var results = {
            errorState: NodeErrorState.SubnodeFail,
            erroredSubpackages: errorDependencies,
            dependencyResults: {commands: null, successfulResults: null, err: null},
            buildResults: {commands: null, successfulResults: null, err: null},
            computedData: null
          };
          cacheVersionedResultAndNotifyWaiters(
            resultsCache,
            packageName,
            {
              lastAttemptedBuildId: currentBuildId,
              lastSuccessfulBuildId: mostRecent.lastSuccessfulBuildId,
              lastSuccessfulPackageResource: mostRecent.lastSuccessfulPackageResource,
              lastBuildIdEffectingProject: mostRecent.lastBuildIdEffectingProject,
              lastBuildIdEffectingDependents: mostRecent.lastBuildIdEffectingDependents,
              results: results
            },
            waiters
          );
          onRootDone(null);
        } else {
          // dirtyDetectingBuilder can return the previous build result (not
          // versioned), and this will simply reversion it to the current id.
          var onBuildDone = function(dependencyResults, buildResults, computedData, effectWholeProject, effectDependents) {
            var errorState = buildResults.err || dependencyResults.err ? NodeErrorState.NodeFail : NodeErrorState.Success;
            var results = {
              errorState: errorState,
              erroredSubpackages: [],
              dependencyResults: dependencyResults,
              buildResults: buildResults,
              computedData: computedData
            };
            cacheVersionedResultAndNotifyWaiters(
              resultsCache,
              packageName,
              errorState !== NodeErrorState.Success ? {
                lastAttemptedBuildId: currentBuildId,
                lastSuccessfulBuildId: mostRecent.lastSuccessfulBuildId,
                lastSuccessfulPackageResource: mostRecent.lastSuccessfulPackageResource,
                lastBuildIdEffectingProject: mostRecent.lastBuildIdEffectingProject,
                lastBuildIdEffectingDependents: mostRecent.lastBuildIdEffectingDependents,
                results: results
              } : {
                lastAttemptedBuildId: currentBuildId,
                lastSuccessfulBuildId: currentBuildId,
                lastSuccessfulPackageResource: resourceCache[packageName],
                lastBuildIdEffectingProject: effectWholeProject ? currentBuildId : mostRecent.lastBuildIdEffectingProject,
                lastBuildIdEffectingDependents: effectDependents ? currentBuildId : mostRecent.lastBuildIdEffectingDependents,
                results: results
              },
              waiters
            );
            onRootDone(null);
          };
          dirtyDetectingBuilder(rootPackageName, resultsCache, prevResultsCache, resourceCache, prevResourceCache, packageName, onBuildDone);
        }
      };
      async.eachLimit(subpackageNames, buildConfig.concurrency, forEachSubpackage, onAllSubpackagesDone);
    }
  }
};

/**
 * If sourceFileMTimes and file sets is the same, no new ocamldep is needed,
 * though recompilation might be needed if other things change (like
 * buildConfig or package.json).
 */
var getMTimesChanged = function(packageResource, lastSuccessfulPackageResource) {
  return !lastSuccessfulPackageResource ||
    arraysDiffer(
      lastSuccessfulPackageResource.packageResources.sourceFileMTimes,
      packageResource.packageResources.sourceFileMTimes
    )
};
var getFileSetChanged = function(packageResource, lastSuccessfulPackageResource) {
  return !lastSuccessfulPackageResource ||
    arraysDiffer(
      packageResource.packageResources.sourceFiles,
      lastSuccessfulPackageResource.packageResources.sourceFiles
    );
};
var getCommonMLChanged = function(packageResource, lastSuccessfulPackageResource) {
  return !lastSuccessfulPackageResource || (
    JSON.stringify(packageResource.packageJSON.CommonML) !==
    JSON.stringify(lastSuccessfulPackageResource.packageJSON.CommonML)
  );
};

/**
 * Might change (native) compilation to be more exact.
 */

var getBuildConfigMightChangeCompilation = function(buildConfig, prevBuildConfig) {
  return !prevBuildConfig ||
    prevBuildConfig.opt !== buildConfig.opt ||
    prevBuildConfig.yacc !== buildConfig.yacc ||
    prevBuildConfig.compiler !== buildConfig.compiler ||
    prevBuildConfig.forDebug !== buildConfig.forDebug;
};

function buildTree() {
  var resourceCachePath =
    path.join(CWD, actualBuildDir(buildConfig), '__resourceCache.json');
  var packageDiagnosticsPath =
    path.join(CWD, actualBuildDir(buildConfig), '__packageDiagnostics.json');
  var compileDiagnosticsPath =
    path.join(CWD, actualBuildDir(buildConfig), '__compileDiagnostics.json');
  var linkDiagnosticsPath =
    path.join(CWD, actualBuildDir(buildConfig), '__linkDiagnostics.json');
  var compilerErrorsPath =
    path.join(CWD, actualBuildDir(buildConfig), '__compilerErrors.json');
  var lexResultsCachePath =
    path.join(CWD, actualBuildDir(buildConfig), '__lexResultsCache.json');
  var buildPackagesResultsCachePath =
    path.join(CWD, actualBuildDir(buildConfig), '__buildPackagesResultsCache.json');
  var buildExecutableResultsCachePath =
    path.join(CWD, actualBuildDir(buildConfig), '__buildExecutableResultsCache.json');
  var prevResourceCache = fs.existsSync(resourceCachePath) ?  JSON.parse(fs.readFileSync(resourceCachePath)) : {};
  var prevBuildPackagesResultsCache =
    fs.existsSync(buildPackagesResultsCachePath) ?
    JSON.parse(fs.readFileSync(buildPackagesResultsCachePath)) : {
      currentBuildId: 22, // Because
      buildConfig: buildConfig,
      alreadyBeingBuiltWithWaiters: {},
      versionedResultsByPackageName: {}
   };
  var prevBuildExecutableResultsCache =
    fs.existsSync(buildExecutableResultsCachePath) ?
    JSON.parse(fs.readFileSync(buildExecutableResultsCachePath)) : {
      currentBuildId: 22, // Because
      buildConfig: buildConfig,
      alreadyBeingBuiltWithWaiters: {},
      versionedResultsByPackageName: {}
   };
  var prevLexResultsCache =
    fs.existsSync(lexResultsCachePath) ?
    JSON.parse(fs.readFileSync(lexResultsCachePath)) : {
      currentBuildId: 22, // Because
      alreadyBeingBuiltWithWaiters: {},
      buildConfig: buildConfig,
      versionedResultsByPackageName: {}
   };

  // Just in case they were serialized in an invalid state.
  prevBuildPackagesResultsCache.alreadyBeingBuiltWithWaiters = {};
  prevBuildExecutableResultsCache.alreadyBeingBuiltWithWaiters = {};
  prevLexResultsCache.alreadyBeingBuiltWithWaiters = {};

  var buildPackagesResultsCache = {
    currentBuildId: prevBuildPackagesResultsCache.currentBuildId + 1,
    alreadyBeingBuiltWithWaiters: {},
    buildConfig: buildConfig,
    versionedResultsByPackageName: {}
  };
  var buildExecutableResultsCache = {
    currentBuildId: prevBuildExecutableResultsCache.currentBuildId + 1,
    alreadyBeingBuiltWithWaiters: {},
    buildConfig: buildConfig,
    versionedResultsByPackageName: {}
  };
  var lexResultsCache = {
    currentBuildId: prevLexResultsCache.currentBuildId + 1,
    alreadyBeingBuiltWithWaiters: {},
    buildConfig: buildConfig,
    versionedResultsByPackageName: {}
  };

  var resourceCache = {};
  var recordResult = recordPackageResourceCacheAndValidate(resourceCache, CWD);
  var rootPackageName = recordResult.rootPackageName;
  if (recordResult.foundPackageInvalidations.length) {
    logError(errorFormatter(recordResult.foundPackageInvalidations));
    log();
    log('Writing Package Errors: ' + packageDiagnosticsPath);
    fs.writeFileSync(packageDiagnosticsPath, JSON.stringify(recordResult.foundPackageInvalidations));
    return;
  }

  var reportStatusAndBackup = function(successful) {
    logTitle("Backing up caches:");
    log('  Resource cache: ' + resourceCachePath);
    log('  Build Packages Results cache: ' + buildPackagesResultsCachePath);
    log('  Build Executable Results cache: ' + buildExecutableResultsCachePath);
    log('  Yacc Results cache: ' + lexResultsCachePath);
    log();
    fs.writeFileSync(resourceCachePath, JSON.stringify(resourceCache));
    fs.writeFileSync(buildPackagesResultsCachePath, JSON.stringify(buildPackagesResultsCache));
    fs.writeFileSync(buildExecutableResultsCachePath, JSON.stringify(buildExecutableResultsCache));
    fs.writeFileSync(lexResultsCachePath, JSON.stringify(lexResultsCache));

    var compileDiagnostics = extractDiagnostics.fromStdErrForAllPackages(buildPackagesResultsCache, buildConfig.logUnextractedErrors);
    var linkDiagnostics = extractDiagnostics.fromStdErrForAllPackages(buildExecutableResultsCache, buildConfig.logUnextractedErrors);
    fs.writeFileSync(compileDiagnosticsPath, JSON.stringify(compileDiagnostics));
    fs.writeFileSync(linkDiagnosticsPath, JSON.stringify(linkDiagnostics));

    log(errorFormatter(compileDiagnostics));
    log(errorFormatter(linkDiagnostics));

    drawBuildGraph(resourceCache, buildPackagesResultsCache, rootPackageName);

    if (!successful) {
      logError(clc.bold('Build Failure: Fix errors and try again'));
    } else {
      logProgress(clc.bold('Build Complete: Sucess!'));
    }
  };

  var continueToBuildExecutable = function() {
    var rootBuildPackagesResults = buildPackagesResultsCache.versionedResultsByPackageName[rootPackageName];
    var shouldRebuildExecutable =
      somePackageResultNecessitatesRelinking(resourceCache, rootPackageName, buildPackagesResultsCache, buildPackagesResultsCache.currentBuildId) ||
      getBuildConfigMightChangeCompilation(buildExecutableResultsCache.buildConfig, prevBuildExecutableResultsCache.buildConfig) ||
      buildExecutableResultsCache.buildConfig.jsCompile && !prevBuildExecutableResultsCache.buildConfig.jsCompile;



    if (rootBuildPackagesResults.lastSuccessfulBuildId !== buildPackagesResultsCache.currentBuildId) {
      // No executable to build because a dependency failed.
      reportStatusAndBackup(false);
    } else if (shouldRebuildExecutable) {
      logTitle('Building executable for ' + rootPackageName);
      log();
      var onExecutableDone = function(buildResults, computedData) {
        if (!buildResults.err) {
          logTitle('Executable built for ' + rootPackageName + ' at ' + computedData.executableArtifact);
          log();
          if (computedData.jsExecutableArtifact) {
            logTitle('JavaScript Executable built for ' + rootPackageName + ' at ' + computedData.jsExecutableArtifact);
            log();
          }
        }
        // var buildResults = {commands: buildScriptForThisPackage, successfulResults: buildOutput, err: null};
        var mostRecent = prevBuildExecutableResultsCache.versionedResultsByPackageName[rootPackageName];
        if (!mostRecent) {
          mostRecent = {
            lastAttemptedBuildId: -1,
            lastSuccessfulBuildId: -1,
            lastSuccessfulPackageResource: null,
            lastBuildIdEffectingProject: -1,
            lastBuildIdEffectingDependents: -1,
            results: null
          };
        }
        var versionedResultForExecutable = {
          lastAttemptedBuildId: buildExecutableResultsCache.currentBuildId,
          lastSuccessfulBuildId: buildResults.err ? mostRecent.lastSuccessfulBuildId : buildExecutableResultsCache.currentBuildId,
          lastSuccessfulPackageResource: buildResults.err ? mostRecent.lastSuccessfulPackageResource : resourceCache[rootPackageName],
          lastBuildIdEffectingProject: buildResults.err ? mostRecent.lastBuildIdEffectingProject : buildExecutableResultsCache.currentBuildId,
          lastBuildIdEffectingDependents: -1,
          results: {
            errorState: buildResults.err ? NodeErrorState.NodeFail : NodeErrorState.Success,
            erroredSubpackages: [],
            dependencyResults: emptyResult,
            buildResults: buildResults,
            computedData: computedData
          }
        };
        cacheVersionedResultAndNotifyWaiters(buildExecutableResultsCache, rootPackageName, versionedResultForExecutable, []);
        reportStatusAndBackup(!buildResults.err);
      };
      buildExecutable(rootPackageName, buildPackagesResultsCache, resourceCache, onExecutableDone);
    } else {
      // No executable to build because either nothing required it, or some dependency failed.
      logTitle('Skipped rebuilding executable ' + rootPackageName);
      log();
      reportStatusAndBackup(true);
    }
  };

  var continueToBuild = function() {
    walkProjectTree(
      rootPackageName,
      buildPackagesResultsCache,
      prevBuildPackagesResultsCache,
      resourceCache,
      prevResourceCache,
      dirtyDetectingBuilder,
      rootPackageName,
      continueToBuildExecutable
    );
  };

  var yaccBuilder = function(rootPackageName, resultsCache, lexResultsCache, resourceCache, prevResourceCache, packageName, onDirtyDetectingBuilderDone) {
    var resource = resourceCache[packageName];
    var packageResources = resource.packageResources;
    var changedLexYaccFiles =
      getLexYaccFilesRequiringRecompilation(resourceCache, prevResourceCache, packageName);
    var scripts =
      changedLexYaccFiles.yacc.length === 0 ? [] : [{
        description: 'Yaccing files',
        scriptLines: changedLexYaccFiles.yacc.map(function(absoluteFilePath) {
          var ocamlYaccCommand = [OCAMLYACC, absoluteFilePath].join(' ');
          return ['echo "Running ocamlyacc:\n' + ocamlYaccCommand + '"', ocamlYaccCommand].join('\n');
        }),
        onFailShouldContinue: false
      }];

    var scriptLines = changedLexYaccFiles.lex.map(function(absoluteFilePath) {
      var ocamlLexCommand = [OCAMLLEX, absoluteFilePath].join(' ');
      return ['echo "Running ocamlyacc:\n' + ocamlLexCommand + '"', ocamlLexCommand].join('\n');
    });
    scripts = scripts.concat(
      changedLexYaccFiles.lex.length === 0 ? [] : [{
        description: 'Lexing files',
        scriptLines: scriptLines,
        onFailShouldContinue: false
      }]
    );
    var onLexYaccFail = function(e) {
      var buildResults = {
        commands: scriptLines,
        successfulResults: null,
        err: e
      };
      onDirtyDetectingBuilderDone(emptyResult, buildResults, {}, true, true);
      logError('Build Fail during ocamllex/ocamlyacc for ' + resource.packageName);
      throw e;
    };

    var onOneOcamlYaccLexDone = function(oneOcamlLexYaccOutput) {
      var buildResults = {commands: scriptLines, successfulResults: oneOcamlLexYaccOutput, err: null};
      onDirtyDetectingBuilderDone(emptyResult, buildResults, {}, true, true);
    };

    if (scripts.length) {
      log('> Running lex/yacc ' + resource.packageName + '\n\n');
    }
    executeScripts(scripts, '', onLexYaccFail, onOneOcamlYaccLexDone);
  };

  // Lex,yacc generate their own .mli/ml artifacts. If we just find all the
  // mll/mly that have changed since last time, run them through ocamllex/yacc
  // preprocessors first, then the rest of the pipeline will correctly detect
  // minimal sets of recompilations for these artifacts.  TODO: Store the
  // output in the _build directory (currently it's difficult because that
  // isn't be done until the final build step).
  if (buildConfig.yacc) {
    logTitle('Building yacc dependencies for ' + rootPackageName);
    log();
    walkProjectTree(
      rootPackageName,
      lexResultsCache,
      prevLexResultsCache,
      resourceCache,
      prevResourceCache,
      yaccBuilder,
      rootPackageName,
      function() {
        /**
         * Now that all projects have their mll/mly converted, scan all the
         * resources again. This should enventually be more cleanly integrated
         * to not produce artifacts in the source directories.
         */
        resourceCache = {};
        var recordResult = recordPackageResourceCacheAndValidate(resourceCache, CWD);
        var rootPackageName = recordResult.rootPackageName;
        if (recordResult.foundPackageInvalidations.length) {
          logError(errorFormatter(recordResult.foundPackageInvalidations));
          log();
          log('Writing Package Errors: ' + packageDiagnosticsPath);
          fs.writeFileSync(packageDiagnosticsPath, JSON.stringify(recordResult.foundPackageInvalidations));
          return;
        }
        continueToBuild();
      }
    );
  } else {
    logTitle('Building dependency packages for ' + rootPackageName);
    log();
    continueToBuild();
  }
}

var whenVerifiedPath = function() {
  try {
    logTitle('Scanning files from ' + CWD);
    log();
    try {
      try {
        buildTree();
      } catch (e) {
        logError('Dependencies scanned and verified, but failed to build');
        logErrorException(e);
      }
    } catch (e) {
      logError('Some packages failed verification');
      logErrorException(e);
    }
  } catch (e) {
    logError('Failure scanning files');
    logErrorException(e);
  }
};

if (buildConfig.jsCompile) {
  whereis('js_of_ocaml', function(err, path) {
    if (err || !path) {
      throw new Error(
        'You have asked to compile to JavaScript ' +
        'but the binary `js_of_ocaml` is not in your path. ' +
        'You probably also want to add an item to your package.json\'s ' +
        'CommonML "findlibPackages": [{"dependency": "js_of_ocaml"}]'
      );
    }
    whenVerifiedPath();
  });
} else {
  whenVerifiedPath();
}
