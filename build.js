var child_process = require('child_process');
var fs = require('fs');
var exec = require('child_process').exec;
var path = require('path');
var args = process.argv;
var optimist = require('optimist');
var clc = require('cli-color');

var argv = optimist.argv;

var STYLE = path.join(__dirname, 'docGenerator', 'docStyle.css');


var cliConfig = {
  hidePath: argv.hidePath,
  silent: argv.silent
};

var buildUniquenessString = function(buildConfig) {
  return '_' + buildConfig.buildCommand + (buildConfig.forDebug ? '_debug' : '');
};

var actualBuildDir = function(buildConfig) {
  return buildConfig.buildDir + buildUniquenessString(buildConfig);
};

var actualBuildDirForDocs = function(buildConfig) {
  return buildConfig.buildDir + buildUniquenessString(buildConfig) + '_doc';
};

var buildConfig = {
  buildCommand: argv.command || 'ocamlc',
  buildDir: argv.buildDir || '_build',
  doc: argv.doc || false,
  forDebug: argv.forDebug === 'true',
};

function invariant(bool, msg) {
  if (!bool) {
    throw new Error(msg);
  }
}
invariant(
  !('forDebug' in argv) || argv.forDebug === 'true' || argv.forDebug === false
);
invariant(
  buildConfig.buildCommand === 'ocamlc' ||
  buildConfig.buildCommand === 'ocamlopt',
  'Must supply either --command=ocamlc or --command=ocamlopt'
);

var VALID_DOCS = ['html', 'latex', 'texi', 'man', 'dot'];
invariant(
  !buildConfig.doc || VALID_DOCS.indexOf(buildConfig.doc) !== -1,
  JSON.stringify(VALID_DOCS) + ' are the only valid values for --doc='
);


var validateFlags = function(compileFlags, linkFlags, packageName) {
  if (compileFlags.indexOf('-g') !== -1 || linkFlags.indexOf('-g') !== -1) {
    throw new Error(
      'A project ' + packageName + ' has debug link/compile flags ' +
      'which should not be configured on a per package basis. ' +
      'Instead pass --forDebug=true '
    );
  }
};
var buildBypass = {
  skipDependencyAnalysis: !!argv.skipDependencyAnalysis
};

var notEmpty = function(o) {
  return o !== null && o !== undefined;
};

var CWD = process.cwd();
var OCAMLDEP = 'ocamldep';
var OCAMLLEX = 'ocamllex';
var OCAMLYACC = 'ocamlyacc';
var OCAMLDOC = 'ocamldoc';
var OCAMLFIND = 'ocamlfind';

var makeSearchPathStrings = function(arr) {
  return arr.map(function(dep) {
    return '-I ' + dep;
  });
};

var objectExtension = function(buildConfig) {
  if (buildConfig.buildCommand === 'ocamlopt') {
    return '.cmx';
  } else {
    return '.cmo';
  }
};

var log = function() {
  if (cliConfig.silent) {
    return;
  }
  console.log.apply(console.log, arguments);
};

var logError = function() {
  var msg = clc.xterm(202);
  console.log(msg.apply(msg, arguments));
};
var logTitle = function() {
  if (cliConfig.silent) {
    return;
  }
  var msg = clc.xterm(222);
  console.log(msg.apply(msg, arguments));
};
var logProgress = function() {
  if (cliConfig.silent) {
    return;
  }
  var msg = clc.xterm(71);
  console.log(msg.apply(msg, arguments));
};

var buildingMsg = '\nBuilding Root Package ' + CWD + ' [' + buildConfig.buildCommand + ']\n';
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

var sourceExtensions = {
  '.mli': true,
  '.ml': true,
  '.mll': true,
  '.mly': true,
};
var isSourceFile = function(absPath) {
  var extName = path.extname(absPath);
  return sourceExtensions[extName];
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
};

function removeBreaks(str) {
  return str.replace(/(\r\n|\n|\r)/gm,"");
}


var aliasPackModuleName = function(packageConfig, internal) {
  return internal ? ('M_Internal_' + packageConfig.packageName) : packageConfig.packageName;
};

/**
 * Path for fake .ml file that contains module aliases for every internal
 * module - opened when compiling each individual internal module.
 */
var aliasMapperFile = function(internal, packageConfig, rootPackageConfig, buildConfig, extension) {
  var unsanitizedAliasModule = path.join(
    packageConfig.realPath,
    lowerBase(aliasPackModuleName(packageConfig, internal)) + extension
  );
  var sanitizedPackPath = sanitizedArtifact(
    unsanitizedAliasModule,
    packageConfig,
    rootPackageConfig,
    buildConfig
  );
  return sanitizedPackPath;
};

var buildArtifact = function(filePath, buildConfig) {
  var extName = path.extname(filePath);
  var isML = extName === '.ml';
  var isMLI = extName === '.mli';
  var basenameBase = path.basename(filePath, extName);
  return isML ? path.resolve(filePath, '..', basenameBase + objectExtension(buildConfig)) :
    isMLI ? path.resolve(filePath, '..', basenameBase + '.cmi') :
    'NEVER_HAPPENS';
};

var buildForDoc = function(packageConfig, rootPackageConfig, buildConfig) {
  var unsanitizedPackPath = path.join(
    packageConfig.realPath,
    lowerBase(packageConfig.packageName) + '.doc'
  );
  var sanitizedPackPath = sanitizedArtifactForDoc(
    unsanitizedPackPath,
    packageConfig,
    rootPackageConfig,
    buildConfig
  );
  return sanitizedPackPath;
};


var buildForExecutable = function(packageConfig, rootPackageConfig, buildConfig) {
  var unsanitizedExecPath =
    path.join(packageConfig.realPath, lowerBase(packageConfig.packageName) + '.out');
  var sanitizedExecPath = sanitizedArtifact(
    unsanitizedExecPath,
    packageConfig,
    rootPackageConfig,
    buildConfig
  );
  return sanitizedExecPath;
};

var isExported = function(packageConfig, filePath) {
  return packageConfig.packageJSON.CommonML.exports.indexOf(upperBasenameBase(filePath)) !== -1;
};

/**
 * Doesn't matter if unsanitized === sanitized.
 */
var getPublicSourceModules = function(unsanitizedPaths, packageConfig) {
  return unsanitizedPaths.filter(function(unsanitizedPath) {
    var extName = path.extname(unsanitizedPath);
    var isML = extName === '.ml';
    if (!isML || !unsanitizedPath) {
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

var getSanitizedPublicOutputs = function(unsanitizedPaths, packageConfig, rootPackageConfig, buildConfig) {
  return getPublicSourceModules(unsanitizedPaths, packageConfig).map(
    function(unsanitizedPath) {
      var unsanitizedArtifact = unsanitizedPath.replace('.ml', objectExtension(buildConfig));
      return sanitizedArtifact(unsanitizedArtifact, packageConfig, rootPackageConfig, buildConfig);
    }
  );
};

var getPublicSourceDirs = function(unsanitizedPaths, packageConfig) {
  var publicModulePaths =
    getPublicSourceModules(unsanitizedPaths, packageConfig);
  return publicModulePaths.map(path.dirname.bind(path));
};

var getPublicBuildDirs = function(unsanitizedPaths, packageConfig, rootPackageConfig, buildConfig) {
  var sanitizedPublicOutputs = getSanitizedPublicOutputs(
    unsanitizedPaths,
    packageConfig,
    rootPackageConfig,
    buildConfig
  );
  return sanitizedPublicOutputs.map(function(sanitizedOutput) {
    return path.dirname(sanitizedOutput);
  });
};

var getFileCopyCommands = function(unsanitizedPaths, packageConfig, rootPackageConfig, buildConfig) {
  return unsanitizedPaths.map(function(unsanitizedPath) {
    if (!isSourceFile(unsanitizedPath)) {
      throw new Error('Do not know what to do with :' + unsanitizedPath);
    }
    return [
      'cp',
      unsanitizedPath,
      sanitizedArtifact(unsanitizedPath, packageConfig, rootPackageConfig, buildConfig),
    ].join(' ');
  });
};

var getFileCopyCommandsForDoc = function(unsanitizedPaths, packageConfig, rootPackageConfig, buildConfig) {
  return unsanitizedPaths.map(function(unsanitizedPath) {
    if (!isSourceFile(unsanitizedPath)) {
      throw new Error('Do not know what to do with :' + unsanitizedPath);
    }
    return [
      'cp',
      unsanitizedPath,
      sanitizedArtifactForDoc(unsanitizedPath, packageConfig, rootPackageConfig, buildConfig),
    ].join(' ');
  });
};


var createAliases = function(unsanitizedPaths, packageConfig) {
  return unsanitizedPaths.map(function(unsanitizedPath) {
    var extName = path.extname(unsanitizedPath);
    var isML = extName === '.ml';
    if (!isML) {
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
  var externalModuleName = aliasPackModuleName(packageConfig, false);
  var internalAliases =
    "(* Automatically generated module aliases file [" + internalModuleName + "].\n * " +
      "All internal modules are compiled with [-open " + internalModuleName + "] \n * " +
      "so that every internal module has immediate access to every other internal module." +
      "\n * A separate module [" +
       externalModuleName +
       "] is automatically generated for modules that depend on \n * " +
       packageConfig.packageName +
       " which only exposes the 'exported' modules in the [package.json]." +
       "\n * This one, however includes all inner modules so that the project itself " +
       "\n * can see even the modules that are not exported.\n *)" +
    createAliases(unsanitizedPaths, packageConfig);
  var externalAliases =
    createAliases(unsanitizedPaths.filter(isExported.bind(null, packageConfig)), packageConfig);
  var internalDotMl = aliasMapperFile(true, packageConfig, rootPackageConfig, buildConfig, '.ml');
  var internalDotMli = aliasMapperFile(true, packageConfig, rootPackageConfig, buildConfig, '.mli');
  var externalDotMl = aliasMapperFile(false, packageConfig, rootPackageConfig, buildConfig, '.ml');
  var externalDotMli = aliasMapperFile(false, packageConfig, rootPackageConfig, buildConfig, '.mli');
  return {
    generateCommands: [
      'echo "' + internalAliases + '" > ' + internalDotMl,
      'echo "' + internalAliases + '" > ' + internalDotMli,
      'echo "' + externalAliases + '" > ' + externalDotMl,
      'echo "' + externalAliases + '" > ' + externalDotMli
    ].join('\n'),
    internalModuleName: internalModuleName,
    externalModuleName: externalModuleName,
    genSourceFiles: {
      internalInterface: internalDotMli,
      internalImplementation: internalDotMl,
      externalInterface: externalDotMli,
      externalImplementation: externalDotMl
    },
    directory: path.resolve(internalDotMl, '..'),
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

var getNamespacedFileOutputCommands = function(compileCommand, unsanitizedPaths, packageConfig, rootPackageConfig, buildConfig) {
  return compileCommand + unsanitizedPaths.map(function(unsanitizedPath) {
    invariant(
      isSourceFile(unsanitizedPath),
      'Do not know what to do with :' + unsanitizedPath
    );
    var sanitizedPath =
      sanitizedArtifact(unsanitizedPath, packageConfig, rootPackageConfig, buildConfig);
    var sanitizedNamespacedModule = namespaceFilePath(packageConfig, sanitizedPath);
    return [
      '-o',
      sanitizedNamespacedModule,
      sanitizedPath
    ].join(' ');
  }).join(' ');

};

var getCompileForDocsOutputCommands = function(compileCommand, unsanitizedPaths, packageConfig, rootPackageConfig, buildConfig) {
  return unsanitizedPaths.map(function(unsanitizedPath) {
    invariant(isSourceFile(unsanitizedPath), 'Do not know what to do with :' + unsanitizedPath);
    var sanitizedPath =
      sanitizedArtifactForDoc(unsanitizedPath, packageConfig, rootPackageConfig, buildConfig);
    return [
      compileCommand,
      sanitizedPath
    ].join(' ');
  });
};

/**
 * Like `getFileOutputs`, but just the output files for ML files and not the
 * commands.
 */
var getModuleArtifacts = function(unsanitizedPaths, packageConfig, rootPackageConfig, buildConfig) {
  return unsanitizedPaths.map(function(unsanitizedPath) {
    var extName = path.extname(unsanitizedPath);
    var isML = extName === '.ml';
    var isMLI = extName === '.mli';
    if (!isSourceFile(unsanitizedPath)) {
      throw new Error('Do not know what to do with :' + unsanitizedPath);
    }
    var basename = path.basename(unsanitizedPath, path.extname(unsanitizedPath));
    return isML ? sanitizedArtifact(
      path.resolve(unsanitizedPath, '..', namespaceLowercase(packageConfig, basename) + objectExtension(buildConfig)),
      packageConfig,
      rootPackageConfig,
      buildConfig
    ) : '';
  });
};


var getSanitizedOutputDirs = function(unsanitizedPaths, packageConfig, rootPackageConfig, buildConfig) {
  var seen = {};
  return unsanitizedPaths.map(function(unsanitizedPath) {
    var extName = path.extname(unsanitizedPath);
    var isML = extName === '.ml';
    var isMLI = extName === '.mli';
    if (!isML && !isMLI) {
      throw new Error('Do not know what to do with :' + unsanitizedPath);
    }
    var unsanitizedArtifact =
      isML ? unsanitizedPath.replace('.ml', objectExtension(buildConfig)) :
      isMLI ? unsanitizedPath.replace('.mli', '.cmi') : 'NEVER_HAPPENS';
    var sanitized =
      sanitizedArtifact(unsanitizedArtifact, packageConfig, rootPackageConfig, buildConfig);
    var dirName = path.dirname(sanitized);
    if (seen[dirName]) {
      return null;
    }
    seen[dirName] = true;
    return dirName;
  }).filter(function(o) {return o !== null;});
};

var getSanitizedOutputDirsForDoc = function(unsanitizedPaths, packageConfig, rootPackageConfig, buildConfig) {
  var seen = {};
  return unsanitizedPaths.map(function(unsanitizedPath) {
    var extName = path.extname(unsanitizedPath);
    var isML = extName === '.ml';
    var isMLI = extName === '.mli';
    if (!isML && !isMLI) {
      throw new Error('Do not know what to do with :' + unsanitizedPath);
    }
    var unsanitizedArtifact =
      isML ? unsanitizedPath.replace('.ml', objectExtension(buildConfig)) :
      isMLI ? unsanitizedPath.replace('.mli', '.cmi') : 'NEVER_HAPPENS';
    var sanitized =
      sanitizedArtifactForDoc(unsanitizedArtifact, packageConfig, rootPackageConfig, buildConfig);
    var dirName = path.dirname(sanitized);
    if (seen[dirName]) {
      return null;
    }
    seen[dirName] = true;
    return dirName;
  }).filter(function(o) {return o !== null;});
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
    path.resolve(rootPackageConfig.realPath, actualBuildDir(buildConfig)),
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
  return path.resolve(
    sanitizedDependencyBuildDirectory(packageConfig, rootPackageConfig, buildConfig),
    originalRelativeToItsPackage
  );
};

var sanitizedArtifactForDoc = function(absPath, packageConfig, rootPackageConfig, buildConfig) {
  var originalRelativeToItsPackage = path.relative(packageConfig.realPath, absPath);
  return path.resolve(
    sanitizedDependencyBuildDirectoryForDoc(packageConfig, rootPackageConfig, buildConfig),
    originalRelativeToItsPackage
  );
};

var baseNameBase = function(filePath) {
  return path.basename(filePath, path.extname(filePath));
};

var upperBasenameBase = function(filePath) {
  var base = baseNameBase(filePath);
  return base[0].toUpperCase() + base.substr(1);
};

var verifyPackageConfig = function(packageConfig) {
  var realPath = packageConfig.realPath;
  var packageName = packageConfig.packageName;
  var packageJSON = packageConfig.packageJSON;
  var CommonML = packageJSON.CommonML;
  var msg = 'Invalid package ' + packageName + ' at ' + realPath + '. ';

  if (!CommonML) {
    // Not a CommonML package
    return;
  }

  var sourceFiles = packageConfig.packageResources.sourceFiles;
  for (var i = 0; i < sourceFiles.length; i++) {
    var sourceFile = sourceFiles[i];
    var extName = path.extname(sourceFile);
    if (extName === '.mli' || extName === '.ml') {
      // Chop off any potential 'ml'
      var basenameBase = path.basename(sourceFile, extName);
      invariant(
        basenameBase.toLowerCase() !== packageConfig.packageName.toLowerCase(),
        msg + 'Package cannot contain module with same name as project ' +
        '(' + sourceFile + ')'
      );
    }
  }

  invariant(packageConfig.realPath, msg + 'No path for package.');
  invariant(
    packageName && packageName.length && packageName[0].toUpperCase() === packageName[0],
    msg + 'package.json `name` must begin with a capital letter.'
  );
  invariant(packageJSON, msg + 'Must have package.json');
  invariant(
    !packageJSON.CommonMl &&
    !packageJSON.commonMl &&
    !packageJSON.commonML &&
    !packageJSON.commonml,
    msg + 'Fix spelling in package.json: It should be spelled "CommonML".'
  );
  invariant(CommonML.exports, msg + 'Must specify exports');
  invariant(
    !CommonML.export,
    msg + '"export" is not a valid field of "CommonML" in package.json'
  );
  invariant(
    !CommonML.export,
    msg + '"export" is not a valid field of "CommonML" in package.json'
  );
  CommonML.exports.forEach(function(exportName) {
    invariant(exportName !== '', 'package.json specifies an exported CommonML module that is the empty string');
    invariant(path.extname(exportName) === '', msg + 'Exports must be module names, not files');
    invariant(
      exportName[0].toUpperCase() === exportName[0],
      msg + 'Exports must be module names - capitalized leading chars.'
    );
    invariant(
      basenameBase !== lowerBase(packageConfig.packageName),
      msg + 'Cannot export the same module name as the package name:' + exportName
    );
  });
};

var generateDotMerlinForPackage = function(autoGenAliases, moduleArtifacts, rootPackageConfig, packageConfig, buildConfig) {
  var commonML = packageConfig.packageJSON.CommonML;
  var linkFlags = commonML.linkFlags;
  var compileFlags = commonML.compileFlags;
  var findlibPackages = commonML.findlibPackages;
  var tags = commonML.tags;
  var buildTags = !tags ? '' : tags.map(function(tg) {return 'B +' + tg;});
  var pkgs = (findlibPackages || []).map(function(pk) {
    return pk.dependency ? ('PKG ' + pk.dependency) : '';
  });
  var filteredCompilerFlags = compileFlags.filter(function(f) {
    return f !== '-i' && f !== '-g' && f !== '-bin-annot'; // This screws up merlin
  });
  var flgs = ['FLG ' + filteredCompilerFlags.join(' ') + ' -open ' + autoGenAliases.internalModuleName];

  var depInternalModuleLocations = [];
  var depPublicBuildLocations = [];
  for (var subpackageName in packageConfig.subpackages) {
    var subpackage = packageConfig.subpackages[subpackageName];
    // This messes merlin up because two different projects can have the same
    // module name (when packed). Once that is resolved this should work.
    // https://github.com/the-lambda-church/merlin/issues/284
    // Otherwise this will work
    var depPublicSourceDirs = getPublicSourceDirs(
      subpackage.packageResources.sourceFiles,
      subpackage
    );
    depInternalModuleLocations.push.apply(
      depInternalModuleLocations,
      depPublicSourceDirs
    );
    var depPublicBuild = getPublicBuildDirs(
      subpackage.packageResources.sourceFiles,
      subpackage,
      rootPackageConfig,
      buildConfig
    );
    depPublicBuildLocations.push.apply(
      depPublicBuildLocations,
      depPublicBuild
    );
  }
  var sanitizedDepPacks = sanitizedDependencyPackDirectories(packageConfig, rootPackageConfig, buildConfig);
  var aliasPack = aliasMapperFile(true, packageConfig, rootPackageConfig, buildConfig);
  var sanitizedPackagePackDir = path.dirname(aliasPack);
  var moduleArtifactsDirs = moduleArtifacts.map(path.dirname.bind(path));
  var merlinBuildDirs =
    moduleArtifactsDirs
    .concat([sanitizedPackagePackDir])
    .concat(sanitizedDepPacks)
    .concat(depPublicBuildLocations);
  // For now, we build right where we have source files
  var buildLines = merlinBuildDirs.map(function(src) {return 'B ' + src;});
  var merlinSourceDirs =
    packageConfig.packageResources.directories
    .concat(depInternalModuleLocations);
  var sourceLines = merlinSourceDirs.map(function(src) {return 'S ' + src;});
  var dotMerlinSource = sourceLines.concat(buildLines)
  .concat(buildTags)
  .concat(pkgs)
  .concat(flgs)
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

var ocbFlagsForPackageCommand = function(command) {
  var dep = command.dependency;
  var syntax = command.syntax;
  if (syntax) {
    return ['-package', syntax, '-syntax', 'camlp4o'].join(' ');
  } else if (dep) {
    return ['-package', dep].join(' ');
  }
};

/**
 * using `ocamlfind` required that we first copy everything over into a _build
 * directory because it couldn't handle multiple -o flags. Turns out it's a
 * pretty good idea anyway. If you don't supply `-linkpkg` nothing works when
 * it comes time to link.
 */
var getFindlibCommand = function(packageConfig, toolchainCommand, linkPkg) {
  var commonML = packageConfig.packageJSON.CommonML;
  var findlibPackages = commonML.findlibPackages;
  var hasFindlibPackages = findlibPackages && findlibPackages.length;
  if (!hasFindlibPackages) {
    return toolchainCommand;
  }
  var findlibBuildCommand = OCAMLFIND + ' ' + toolchainCommand;

  var findlibFlags =
    hasFindlibPackages ?
    findlibPackages.map(ocbFlagsForPackageCommand).join(' ') : '';

  // We will be outputting to standard out *right now* on the fly, so we should
  // notify that we are - This makes building messy in the console but only
  // happens when using ocamlfind.
  var echoMsg = "> Running ocamlfind to determine build command.\n" +
    "Try to avoid use of findlibPackages, they make building messy and very slow.";
  child_process.execSync('echo "' + echoMsg + '"');

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
var getFilesNeedingRecompilation = function(resourceCache, packageConfig, buildOrdering) {
  var cachedResource = resourceCache.byPath[packageConfig.realPath];
  if (!cachedResource) {
    return buildOrdering;
  }
  var previousBuildOrdering = cachedResource.ocamldepOutput;
  var previousSourceFiles = cachedResource.shallowPackageConfig.packageResources.sourceFiles;
  var previousSourceFileMTimes = cachedResource.shallowPackageConfig.packageResources.sourceFileMTimes;
  var nextSourceFiles = packageConfig.packageResources.sourceFiles;
  var nextSourceFileMTimes = packageConfig.packageResources.sourceFileMTimes;

  // d represents the first index where we found something different.  By the
  // end of loop, d will be at most the length of array (because of the last
  // d++).
  var firstChangedIndex = -1;
  for (var d = 0; d < buildOrdering.length; d++) {
    var absPath = buildOrdering[d];
    var indexInPreviousSourceFiles = previousSourceFiles.indexOf(absPath);
    var indexInNextSourceFiles = nextSourceFiles.indexOf(absPath);
    var nextMTime = nextSourceFileMTimes[indexInNextSourceFiles];
    if (indexInPreviousSourceFiles === -1) {
      firstChangedIndex = d;
      break;
    } else {
      invariant(indexInNextSourceFiles !== -1, 'Cannot find ocamldep supplied source ' + absPath);
      var previousMTime = previousSourceFileMTimes[indexInPreviousSourceFiles];
      if (previousMTime !== nextMTime) {
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
var getLexYaccFilesRequiringRecompilation = function(resourceCache, packageConfig) {
  var cachedResource = resourceCache.byPath[packageConfig.realPath];
  var previousSourceFiles = cachedResource ?
    cachedResource.shallowPackageConfig.packageResources.sourceFiles :
    [];
  var previousSourceFileMTimes = cachedResource ?
    cachedResource.shallowPackageConfig.packageResources.sourceFileMTimes :
    [];
  var nextSourceFiles = packageConfig.packageResources.sourceFiles;
  var nextSourceFileMTimes = packageConfig.packageResources.sourceFileMTimes;
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

var sanitizedImmediateDependenciesPublicPaths = function(packageConfig, rootPackageConfig, buildConfig) {
  var immediateDependenciesPublicDirs = [];
  var subpackages = packageConfig.subpackages;
  for (var subpackageName in subpackages) {
    var subpackage = subpackages[subpackageName];
    immediateDependenciesPublicDirs.push.apply(
      immediateDependenciesPublicDirs,
      getPublicBuildDirs(subpackage.packageResources.sourceFiles, subpackage, rootPackageConfig, buildConfig)
    );
  }
  return immediateDependenciesPublicDirs;
};

var buildScriptFromOCamldep = function(resourceCache, rootPackageConfig, buildConfig, walkResults) {
  var ret = [];
  var prevTransitiveArtifacts = [];
  // TODO: someDependentProjectNeededRecompilationInAWayThatChangedPublicInterface
  var someDependentProjectNeededRecompilation = false;
  var compileCommands = walkResults.map(function(result) {
    var packageConfig = result.packageConfig;
    var packageName = packageConfig.packageName;
    var buildingLibraryMsg = 'Building library ' + packageConfig.packageName;
    var cachedResource = resourceCache.byPath[packageConfig.realPath];
    var packageResources = packageConfig.packageResources;
    var commonML = packageConfig.packageJSON.CommonML;
    var linkFlags = commonML.linkFlags;
    var compileFlags = commonML.compileFlags || [];
    var docFlags = commonML.docFlags || [];
    var tags = commonML.tags;

    validateFlags(compileFlags, linkFlags, packageName);

    var mTimesOrFileSetChanged = getMTimesOrFileSetChanged(resourceCache, packageConfig);
    var buildConfigMightChangeCompilation =
      getBuildConfigMightChangeCompilation(resourceCache, buildConfig);
    var commonMLChanged = getCommonMLChanged(resourceCache, packageConfig);
    var projectFilesMightNeedRecompiling =
      mTimesOrFileSetChanged ||
      buildConfigMightChangeCompilation ||
      commonMLChanged;

    var mightNeedSomething =
      projectFilesMightNeedRecompiling || someDependentProjectNeededRecompilation;

    var ocamldepOrderedSourceFiles = result.ocamldepOutput;
    // TODO: The only practical way to achieve minimal rebuilds, is to get the
    // `ocamldep` graph output. It's not as simple as finding changed mtimes of
    // interfaces (explicit or implicit). An interface myInterface.mli can
    // `include OtherModule_Intf.S`, so the myInterface.mli did not actually
    // change. So the only way is to track individual file dependencies within
    // any single project. For better dependency tracking, we can use
    // compiler-libs to cache the type of interfact files.
    //
    // We can conclude that our package's change won't necessitate
    // recompilation of packages that depend on it if there is no transitive
    // dependency between the exported modules' interfaces, and the files that
    // changed. If there is a transitive dependency, we have no choice but to
    // assume the change will necessitate recompilation of our package's
    // dependencies, though we have no way to know for certain.
    var sourceFilesToRecompile =
      buildConfigMightChangeCompilation || commonMLChanged || someDependentProjectNeededRecompilation ?
      ocamldepOrderedSourceFiles :
      getFilesNeedingRecompilation(resourceCache, packageConfig, ocamldepOrderedSourceFiles);

    var needsModuleRecompiles = sourceFilesToRecompile.length > 0;


    /**
     * Compiling individual modules
     * TODO: Can we avoid copying entirely? I believe so.
     */
    var fileCopyCommands = getFileCopyCommands(
      sourceFilesToRecompile,
      packageConfig,
      rootPackageConfig,
      buildConfig
    );

    var allCompilerFlags = [
      '-c',
    ].concat(compileFlags);

    var fileOutputDirs = getSanitizedOutputDirs(
      ocamldepOrderedSourceFiles,
      packageConfig,
      rootPackageConfig,
      buildConfig
    );

    /**
     * Compiling alias files for public/internal consumption of this module.
     */
    var autoGenAliases = autogenAliasesCommand(
      ocamldepOrderedSourceFiles,
      packageConfig,
      rootPackageConfig,
      buildConfig
    );

    var searchPaths = makeSearchPathStrings(
      prevTransitiveArtifacts.map(path.dirname.bind(path))
      .concat(fileOutputDirs)
      .concat([autoGenAliases.directory])
      .concat(sanitizedImmediateDependenciesPublicPaths(packageConfig, rootPackageConfig, buildConfig))
    );

    var compileCommand =
      getFindlibCommand(packageConfig, buildConfig.buildCommand, false);

    var singleFileCompile =
      [compileCommand]
      .concat(allCompilerFlags)
      .concat(searchPaths)
      .concat(['-bin-annot -open', autoGenAliases.internalModuleName]).join(' ') + ' ';

    // The performance of this will be horrible if using ocamlfind with custom
    // packages - it takes a long time to look those up, and we do it for every
    // file! In the future, cache the result of the findlib command.
    var compileModulesCommands = getNamespacedFileOutputCommands(
      singleFileCompile,
      sourceFilesToRecompile,
      packageConfig,
      rootPackageConfig,
      buildConfig
    );

    // Always repack regardless of what changed it's pretty cheap.
    var compileAliasesCommand =
      [compileCommand]
      // -bin-annot generates .cmt files for the pack which merlin needs to
      // work correctly.
      // Need to add -49 so that it doesn't complain because we haven't
      // actually compiled the namespaced modules yet. They are like forward
      // declarations in that sense.
      .concat(['-bin-annot -no-alias-deps -w -49'])
      .concat(searchPaths)
      .concat([
        autoGenAliases.genSourceFiles.internalInterface,
        autoGenAliases.genSourceFiles.internalImplementation,
        autoGenAliases.genSourceFiles.externalInterface,
        autoGenAliases.genSourceFiles.externalImplementation
      ])
      .join(' ');

    var ensureDirectoriesCommand = [
      'mkdir',
      '-p',
    ].concat(fileOutputDirs).join(' ');



    var executableArtifact = packageConfig === rootPackageConfig ?
      buildForExecutable(packageConfig, rootPackageConfig, buildConfig) :
      null;


    // TODO: docs compilation
    // Make -g option per task not per project
    // Test ocamldebug
    // Fix compile output errors linking to `_build`

    /**
     * Documentation. Have to compile a special version without namespaces so
     * that ocamldoc is not confused!
     */
    var docArtifact = buildForDoc(packageConfig, rootPackageConfig, buildConfig);
    var findlibDocCommand = getFindlibCommand(packageConfig, OCAMLDOC, false);
    var allDocFlags =
      docFlags.concat(['-' + buildConfig.doc])
      .concat(['-colorize-code', '-all-params']);

    // TODO: Can we avoid copying entirely? I believe so.
    var fileCopyCommandsForDoc = getFileCopyCommandsForDoc(
      sourceFilesToRecompile,
      packageConfig,
      rootPackageConfig,
      buildConfig
    );

    var fileOutputDirsForDoc = getSanitizedOutputDirsForDoc(
      ocamldepOrderedSourceFiles,
      packageConfig,
      rootPackageConfig,
      buildConfig
    );
    var searchPathsForDocs = makeSearchPathStrings(
      prevTransitiveArtifacts.map(path.dirname.bind(path))
      .concat(fileOutputDirsForDoc)
    );
    var ensureDirectoryCommandForDoc = [
      'mkdir',
      '-p',
      docArtifact
    ].join(' ');
    var ensureDirectoriesCommandForDocIntermediateBuilds = [
      'mkdir',
      '-p',
    ].concat(fileOutputDirsForDoc).join(' ');

    var singleFileCompileForDocs =
      [compileCommand]
      .concat(allCompilerFlags)
      .concat(searchPathsForDocs)
      .concat(['-bin-annot']).join(' ');

    var compileNonNamespacedModulesForDocsCommands = getCompileForDocsOutputCommands(
      singleFileCompileForDocs,
      sourceFilesToRecompile,
      packageConfig,
      rootPackageConfig,
      buildConfig
    );

    var compileActualDocumentationCommand = !buildConfig.doc ? '' :
      [findlibDocCommand]
      .concat(searchPathsForDocs)
      .concat(allDocFlags)
      .concat(sourceFilesToRecompile)
      .concat(['-d', docArtifact])
      .concat(['-css-style', STYLE])
      .join(' ');


    /**
     * Dependency tracking.
     */

    // We could pass all of `ocamldepOrderedSourceFiles`, but that creates
    // build artifacts. So we can supply all of the already built artifacts
    // (in the _build) folder, but that won't accept .cmi's so we must only
    // get the .cmos.
    var justTheModuleArtifacts =
      getModuleArtifacts(ocamldepOrderedSourceFiles, packageConfig, rootPackageConfig, buildConfig);
    prevTransitiveArtifacts.push(buildArtifact(autoGenAliases.genSourceFiles.externalImplementation, buildConfig));
    prevTransitiveArtifacts.push(buildArtifact(autoGenAliases.genSourceFiles.internalImplementation, buildConfig));
    prevTransitiveArtifacts.push.apply(prevTransitiveArtifacts, justTheModuleArtifacts);
    // The root package should be runable
    var findlibLinkCommand = getFindlibCommand(packageConfig, buildConfig.buildCommand, true);
    var compileExecutableCommand = !executableArtifact ? '' :
      [findlibLinkCommand]
      .concat(['-o', executableArtifact])
      .concat(linkFlags)
      .concat(searchPaths)
      .concat(prevTransitiveArtifacts)
      .join(' ');


    var compileCommands =
      (mightNeedSomething && needsModuleRecompiles ? [compileAliasesCommand].concat(compileModulesCommands) : [])
      .concat(mightNeedSomething && executableArtifact ? [compileExecutableCommand] : []);

    var compileModulesMsg =
      sourceFilesToRecompile.length === 0 ?
        'echo " > No files need recompilation, packing in ' + packageConfig.packageName +
        (mightNeedSomething ? '. Will link if root package.' : '. Will not link.') + '"' :
      sourceFilesToRecompile.length < ocamldepOrderedSourceFiles.length ?
        'echo " > Incrementally recompiling, packing and (if needed) linking ' + packageName +
        ' modules [ ' + sourceFilesToRecompile.join(' ') + ' ]"' : '';

    var compileCmdMsg =
      [boxMsg(buildingLibraryMsg), compileModulesMsg]
      .concat(compileCommands.length === 0 ? [] : [
        'echo " > OCaml Toolchain:"',
        // having echo use single quotes doesn't destroy any of the quotes in
        // findlib commands
        "echo ' > " + compileCommands.join("\n> ") + "'"
      ]).join('\n');

    var merlinFile = path.join(packageConfig.realPath, '.merlin');
    var merlinCommand = [
      'echo " > Autocomplete .merlin file for ' + merlinFile + ':"',
      'echo "',
      generateDotMerlinForPackage(autoGenAliases, justTheModuleArtifacts, rootPackageConfig, packageConfig, buildConfig),
      '" > ' + merlinFile,
    ].join('\n');

    var docCommandMsg = [
      'echo "> Generating documentation:"',
      'echo " > Generating dedicated build just for docs:"',
      'echo " > ' + compileNonNamespacedModulesForDocsCommands.join('\n') + '"',
      'echo " > ' + compileActualDocumentationCommand + '"'
    ].join('\n');

    var echoDocLocationCommand = 'echo " > Documentation at: file://' + docArtifact + '/index.html"';

    var buildScriptForThisPackage = [];
    var buildDocScriptForThisPackage = [];
    buildScriptForThisPackage.push(ensureDirectoriesCommand);
    buildScriptForThisPackage.push(autoGenAliases.generateCommands);
    buildScriptForThisPackage.push.apply(buildScriptForThisPackage, fileCopyCommands);
    buildScriptForThisPackage.push(compileCmdMsg);
    buildScriptForThisPackage.push.apply(buildScriptForThisPackage, compileCommands);
    buildScriptForThisPackage.push(merlinCommand);
    buildConfig.doc && buildDocScriptForThisPackage.push(docCommandMsg);
    buildConfig.doc && buildDocScriptForThisPackage.push(ensureDirectoryCommandForDoc);
    buildConfig.doc && buildDocScriptForThisPackage.push(ensureDirectoriesCommandForDocIntermediateBuilds);
    buildConfig.doc && buildDocScriptForThisPackage.push.apply(buildDocScriptForThisPackage, fileCopyCommandsForDoc);
    buildConfig.doc && buildDocScriptForThisPackage.push.apply(buildDocScriptForThisPackage, compileNonNamespacedModulesForDocsCommands);
    buildConfig.doc && buildDocScriptForThisPackage.push(compileActualDocumentationCommand);
    buildConfig.doc && buildDocScriptForThisPackage.push(echoDocLocationCommand);
    someDependentProjectNeededRecompilation = mightNeedSomething;
    ret.push({
      description: 'Build Script For ' + packageConfig.packageName,
      scriptLines: buildScriptForThisPackage,
      onFailShouldContinue: false
    });
    buildConfig.doc && ret.push({
      description: 'Doc Build Script For ' + packageConfig.packageName,
      scriptLines: buildDocScriptForThisPackage,
      onFailShouldContinue: true
    });
  });
  return ret;
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

function getPackageResources(absRootDir) {
  var start = (new Date()).getTime();
  var dirList = fs.readdirSync(absRootDir);
  var end = (new Date()).getTime();
  var directories = [];
  var sourceFiles = [];
  var sourceFileMTimes = [];
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
    } else if (isSourceFile(absPath)) {
      sourceFiles.push(absPath);
      sourceFileMTimes.push(stats.mtime.getTime());
    }
  });

  for (var i = 0; i < directories.length; i++) {
    var subdir = directories[i];
    var subresults = getPackageResources(subdir);
    directories.push.apply(directories, subresults.directories);
    sourceFiles.push.apply(sourceFiles, subresults.sourceFiles);
    sourceFileMTimes.push.apply(sourceFileMTimes, subresults.sourceFileMTimes);
  }
  return {
    directories: directories,
    sourceFiles: sourceFiles,
    sourceFileMTimes: sourceFileMTimes,
  };
}

function getPackageResourcesForRoot(absDir) {
  var sourceDir = path.join(absDir, 'src');
  if (!directoryExistsSync(sourceDir)) {
    logError('Does not appear to be a CommonML package with `src` directory:' + absDir);
    return {
      directories: [],
      sourceFiles: [],
      sourceFileMTimes: [],
    };
  }
  return getPackageResources(sourceDir);
}

function sanitizedDependencyPackDirectories(packageConfig, rootPackageConfig, buildConfig) {
  var dependencyPackDirectories = [];
  var subpackages = packageConfig.subpackages;
  for (var subpackageName in subpackages) {
    var subpackage = subpackages[subpackageName];
    var sanitizedPackOutput = aliasMapperFile(false, subpackage, rootPackageConfig, buildConfig);
    dependencyPackDirectories.push(path.dirname(sanitizedPackOutput));
  }
  return dependencyPackDirectories;
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
    throw new Error('No package.json file for package at ' + absDir);
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
      if (packageJSON && packageJSON.CommonML && packageName !== 'CommonML') {
        ret = ret || {};
        ret[packageName] = {
          realPath: realPath,
          packageJSON: packageJSON
        };
      }
    }
  }
  return ret;
}

function getSubprojectPackageConfigTree(absRootDir, currentlyVisitingByRealPath, packageConfigCacheByRealPath) {
  var subprojectDir = path.join(absRootDir, 'node_modules');
  var subdescriptors = getSubprojectPackageDescriptors(subprojectDir);
  var subtree = {};
  for (var subpackageName in subdescriptors) {
    var subdescriptor = subdescriptors[subpackageName];
    // TODO: packageConfigCacheByRealPath isn't even being used
    if (!packageConfigCacheByRealPath[subdescriptor.realPath]) {
      if (currentlyVisitingByRealPath[subdescriptor.realPath]) {
        console.log('Circular dependency on ' + subdescriptor.realPath + ' from ' + absRootDir);
        continue;
      }
      currentlyVisitingByRealPath[subdescriptor.realPath] = true;
      var subpackages = getSubprojectPackageConfigTree(subdescriptor.realPath, currentlyVisitingByRealPath, packageConfigCacheByRealPath);
      subtree[subpackageName] = {
        packageName: subpackageName,
        packageResources: getPackageResourcesForRoot(subdescriptor.realPath),
        realPath: subdescriptor.realPath,
        packageJSON: subdescriptor.packageJSON,
        subpackages: subpackages
      };
      currentlyVisitingByRealPath[subdescriptor.realPath] = false;
    } else {
      // No need to do it again, this has already been discovered.
      subtree[subpackageName] = packageConfigCacheByRealPath[subdescriptor.realPath];
    }
  }
  return subtree;
}

function getProjectPackageConfigTree(absRootDir) {
  var currentlyVisitingByRealPath = {};
  var packageConfigCacheByRealPath = {};
  currentlyVisitingByRealPath[absRootDir] = true;
  var subpackages = getSubprojectPackageConfigTree(absRootDir, currentlyVisitingByRealPath, packageConfigCacheByRealPath);
  return {
    packageName: path.basename(absRootDir),
    packageResources: getPackageResourcesForRoot(absRootDir),
    realPath: absRootDir,
    packageJSON: getPackageJSONForPackage(absRootDir),
    subpackages: subpackages
  };
}

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
        onFailTerminate(error || stderr);
      }
    });
  }
};

var _walkSubprojects = function(resultsSoFar, roots, onEach, onDone) {
  if (roots.length === 0) {
    onDone(resultsSoFar);
  } else {
    _walkProjectTree(resultsSoFar, roots[0], onEach, function(doneRootProject, recurseResults) {
      var nextResultsSoFar = resultsSoFar.concat(recurseResults);
      _walkSubprojects(nextResultsSoFar, roots.slice(1), onEach, onDone);
    });
  }
};

var _walkProjectTree = function(resultsSoFar, root, onEach, onWalkComplete) {
  var packageNames = Object.keys(root.subpackages);
  var subpackages = packageNames.map(function(name) {return root.subpackages[name];});
  _walkSubprojects(resultsSoFar, subpackages, onEach, function(recurseResults){
    onEach(root, function(rootDoneResult) {
      var doneRootProject = root;
      onWalkComplete(doneRootProject, recurseResults.concat([rootDoneResult]));
    });
  });
};

/**
 * Walks project tree, invoking `onEach` for each project, in topological sort
 * order. Returns the topologically ordered list of "return" values from
 * `onEach`'s `onOneDone` invocation.
 */
var walkProjectTree = _walkProjectTree.bind(null, []);

var computeResourceCache = function(buildConfig, walkResults) {
  var byPath = {};
  var _getResourceCacheNodeByPackagePath = function(result) {
    // Transform depth into links (to avoid redundant subtrees)
    var shallowNode = {
      shallowPackageConfig: {},
      ocamldepOutput: result.ocamldepOutput
    };
    for (var prop in result.packageConfig) {
      if (prop !== 'subpackages') {
        shallowNode.shallowPackageConfig[prop] = result.packageConfig[prop];
      }
    }
    var subpackageAbsolutePaths = [];
    for (var subpackageName in result.packageConfig.subpackages) {
      var subpackage = result.packageConfig.subpackages[subpackageName];
      subpackageAbsolutePaths.push(subpackage.realPath);
    }
    shallowNode.subpackageAbsolutePaths = subpackageAbsolutePaths;
    byPath[result.packageConfig.realPath] = shallowNode;
  };
  walkResults.forEach(_getResourceCacheNodeByPackagePath);
  return {byPath: byPath, buildConfig: buildConfig};
};

/**
 * If sourceFileMTimes and file sets is the same, no new ocamldep is needed,
 * though recompilation might be needed if other things change (like
 * buildConfig or package.json).
 */
var getMTimesOrFileSetChanged = function(resourceCache, packageConfig) {
  var cachedResource = resourceCache.byPath[packageConfig.realPath];
  return !cachedResource ||
    arraysDiffer(
      cachedResource.shallowPackageConfig.packageResources.sourceFileMTimes,
      packageConfig.packageResources.sourceFileMTimes
    ) ||
    arraysDiffer(
      cachedResource.shallowPackageConfig.packageResources.sourceFiles,
      packageConfig.packageResources.sourceFiles
    );
};

var getCommonMLChanged = function(resourceCache, packageConfig) {
  var cachedResource = resourceCache.byPath[packageConfig.realPath];
  return !cachedResource || (
    JSON.stringify(cachedResource.shallowPackageConfig.packageJSON.CommonML) !==
    JSON.stringify(packageConfig.packageJSON.CommonML)
  );
};

var getBuildConfigMightChangeCompilation = function(resourceCache, buildConfig) {
  return !resourceCache.buildConfig ||
    resourceCache.buildConfig.buildCommand !== buildConfig.buildCommand ||
    resourceCache.buildConfig.forDebug !== buildConfig.forDebug;
};

function buildTree(tree) {
  var resourceCachePath =
    path.join(tree.realPath, actualBuildDir(buildConfig), '_resourceCache.json');
  var pattern = cliConfig.hidePath ? cliConfig.hidePath.replace(/\//g, '\\\/')  : null;
  var filterRE = new RegExp(pattern, "g");
  var filterOutput = cliConfig.hidePath ? function(str) {
    return str.replace(filterRE, '');
  } : null;
  var previousResourceCache =
    fs.existsSync(resourceCachePath) ?
    JSON.parse(fs.readFileSync(resourceCachePath)) :
    {byPath: {}};

  var onOcamldepDone = function(rootPackageConfig, walkResults) {
    var makeScripts = buildScriptFromOCamldep(
      previousResourceCache,
      rootPackageConfig,
      buildConfig,
      walkResults
    );
    var onBuildFail = function(e) {
      logError('Build Failed executing generated build script');
      throw e;
    };
    var onBuildComplete = function(e) {
      log('Backing up resource cache to ' + resourceCachePath);
      logProgress('*Build Complete*');
      fs.writeFileSync(
        resourceCachePath,
        JSON.stringify(computeResourceCache(buildConfig, walkResults))
      );
    };
    // console.log('make script:\n', makeScripts.join('\n'));
    executeScripts(makeScripts, '', onBuildFail, onBuildComplete, filterOutput);
  };

  var shouldSkipDependencySteps = function(previousResourceCache, packageConfig) {
    return (
      previousResourceCache.byPath[packageConfig.realPath] &&
      buildBypass.skipDependencyAnalysis
    ) || !getMTimesOrFileSetChanged(previousResourceCache, packageConfig);
  };

  var continueToDependencyAnalysis = function() {
    walkProjectTree(tree, function(packageConfig, onOneDone) {
      verifyPackageConfig(packageConfig);
      var packageResources = packageConfig.packageResources;
      var onOcamldepFail = function(e) {
        logError('Build failed executing finding dependency ordering for ' + packageConfig.packageName);
        throw e;
      };

      if (shouldSkipDependencySteps(previousResourceCache, packageConfig)) {
        log('> Skipping dependency computing for ' + packageConfig.packageName);
        onOneDone({
          packageConfig: packageConfig,
          ocamldepOutput: previousResourceCache.byPath[packageConfig.realPath].ocamldepOutput
        });
        return;
      }

      var onOneOcamldepDone = function(oneOcamldepOutput) {
        onOneDone({
          packageConfig: packageConfig,
          ocamldepOutput: removeBreaks(oneOcamldepOutput).split(' ').filter(function(s) {
            return s !== '';
          })
        });
      };
      var findlibOCamldepCommand = getFindlibCommand(packageConfig, OCAMLDEP, false);
      log('> Computing dependencies for ' + packageConfig.packageName + '\n\n');
      var cmd =
        [findlibOCamldepCommand]
        .concat(['-sort', '-one-line'].join(' '))
        .concat(packageResources.sourceFiles)
        .join(' ');
      log(cmd);
      var scripts = [{
        description: 'ocamldep script',
        scriptLines: [cmd],
        onFailShouldContinue: false
      }];
      executeScripts(scripts, '', onOcamldepFail, onOneOcamldepDone, filterOutput);
    }, onOcamldepDone);
  };


  // Lex,yacc generate their own .mli/ml artifacts. If we just find all the
  // mll/mly that have changed since last time, run them through ocamllex/yacc
  // preprocessors first, then the rest of the pipeline will correctly detect
  // minimal sets of recompilations for these artifacts.  TODO: Store the
  // output in the _build directory (currently it's difficult because that
  // isn't be done until the final build step).
  walkProjectTree(tree, function(packageConfig, onOneDone) {
    verifyPackageConfig(packageConfig);
    var packageResources = packageConfig.packageResources;
    var onLexYaccFail = function(e) {
      logError('Build Fail during ocamllex/ocamlyacc for ' + packageConfig.packageName);
      throw e;
    };

    if (shouldSkipDependencySteps(previousResourceCache, packageConfig)) {
      log('> Skipping lex/yacc for ' + packageConfig.packageName);
      onOneDone({});
      return;
    }
    var onOneOcamlYaccLexDone = function(oneOcamldepOutput) {
      onOneDone({
        packageConfig: packageConfig,
        ocamldepOutput: removeBreaks(oneOcamldepOutput).split(' ').filter(function(s) {
          return s !== '';
        })
      });
    };

    var changedLexYaccFiles =
      getLexYaccFilesRequiringRecompilation(previousResourceCache, packageConfig);
    var scripts =
      changedLexYaccFiles.yacc.length === 0 ? [] : [{
        description: 'Yaccing files',
        scriptLines: changedLexYaccFiles.yacc.map(function(absoluteFilePath) {
          var ocamlYaccCommand = [OCAMLYACC, absoluteFilePath].join(' ');
          return [
            'echo "Running ocamlyacc:\n' + ocamlYaccCommand + '"',
            ocamlYaccCommand
          ].join('\n');
        }),
        onFailShouldContinue: false
      }];

    scripts = scripts.concat(
      changedLexYaccFiles.lex.length === 0 ? [] : [{
        description: 'Lexing files',
        scriptLines: changedLexYaccFiles.lex.map(function(absoluteFilePath) {
          var ocamlLexCommand = [OCAMLLEX, absoluteFilePath].join(' ');
          return [
            'echo "Running ocamlyacc:\n' + ocamlLexCommand + '"',
            ocamlLexCommand
          ].join('\n');
        }),
        onFailShouldContinue: false
      }]
    );

    if (scripts.length) {
      log('> Running lex/yacc ' + packageConfig.packageName + '\n\n');
    }
    executeScripts(scripts, '', onLexYaccFail, onOneOcamlYaccLexDone, filterOutput);
  }, continueToDependencyAnalysis);


}

var tree;
try {
  log('Scanning files from ' + CWD);
  tree = getProjectPackageConfigTree(CWD);
  try {
    verifyPackageConfig(tree);
    try {
      buildTree(tree);
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
