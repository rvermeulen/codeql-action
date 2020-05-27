"use strict";
var __importStar = (this && this.__importStar) || function (mod) {
    if (mod && mod.__esModule) return mod;
    var result = {};
    if (mod != null) for (var k in mod) if (Object.hasOwnProperty.call(mod, k)) result[k] = mod[k];
    result["default"] = mod;
    return result;
};
Object.defineProperty(exports, "__esModule", { value: true });
const core = __importStar(require("@actions/core"));
const exec = __importStar(require("@actions/exec"));
const io = __importStar(require("@actions/io"));
const glob = __importStar(require("@actions/glob"));
const fs = __importStar(require("fs"));
const path = __importStar(require("path"));
const yaml = __importStar(require("js-yaml"));
const util = __importStar(require("./util"));
async function rewriteDefaultQueries(codeqlCmd, config) {
    const workspace = util.workspaceFolder();
    const rewriteFolder = path.join(workspace, 'rewritten-ql-packs');
    await io.mkdirP(rewriteFolder);
    core.startGroup("CodeQL QL pack rewriting for query extensions");
    let qlpacks = '';
    core.info("Collecting QL packs");
    await exec.exec(codeqlCmd, [
        'resolve',
        'qlpacks',
        '--format=json'
    ], {
        silent: true,
        listeners: {
            stdout: (data) => { qlpacks += data.toString(); },
            stderr: (data) => { process.stderr.write(data); }
        }
    });
    const qlpacksDictionary = JSON.parse(qlpacks);
    for (const queryExtension of config.queryExtensions) {
        if (qlpacksDictionary[queryExtension.target]) {
            core.info('Found QL pack "' + queryExtension.target + '" targeted by query extension "' + queryExtension.name + '"');
            const qlpackFolder = path.join(rewriteFolder, queryExtension.target);
            core.info('Creating rewrite folder "' + qlpackFolder + '"');
            io.mkdirP(qlpackFolder);
            const options = { recursive: true, force: false };
            const firstPath = qlpacksDictionary[queryExtension.target][0];
            core.info('Copying "' + firstPath + '" to rewrite folder "' + qlpackFolder + '"');
            io.cp(firstPath, qlpackFolder, options);
            core.info('Rewriting QL pack "' + queryExtension.target + '" by looking for query files in "' + qlpackFolder + '/**/*.ql"');
            const queryFileGlobber = await glob.create(qlpackFolder + '/**/*.ql');
            let rewrittenQueryCount = 0;
            for await (const file of queryFileGlobber.globGenerator()) {
                fs.readFile(file, 'utf8', (err, query) => {
                    if (err) {
                        throw new Error('Unable to read the query "' + file + '", because of error' + err);
                    }
                    if (query.search(queryExtension.trigger) !== -1) {
                        core.info('Rewriting query "' + file + '"');
                        const rewrittenImports = [queryExtension.trigger].concat(queryExtension.imports);
                        const rewrittenQuery = query.replace(queryExtension.trigger, rewrittenImports.join("\n"));
                        fs.writeFile(file, rewrittenQuery, (err) => {
                            if (err) {
                                throw new Error('Unable to write the query "' + file + '", because of error:' + err);
                            }
                        });
                        rewrittenQueryCount++;
                    }
                    else {
                        core.info('Query file "' + file + '" does not contain the trigger "' + queryExtension.trigger + '"');
                    }
                });
            }
            core.info('Rewritten ' + rewrittenQueryCount + ' queries.');
            if (rewrittenQueryCount !== 0) {
                core.info('Updating QL pack library dependencies');
                const queryExtensionPack = yaml.safeLoad(fs.readFileSync(path.join(queryExtension.uses, 'qlpack.yml'), 'utf8'));
                const queryPackGlobber = await glob.create(qlpackFolder + '/**/qlpack.yml');
                for await (const file of queryPackGlobber.globGenerator()) {
                    const queryPack = yaml.safeLoad(fs.readFileSync(file, 'utf8'));
                    if (queryPack.name !== queryExtension.target) {
                        core.info('Skipping QL pack "' + file + '" not matching the target "' + queryExtension.target + '"');
                        continue;
                    }
                    let libraryPathDependencies = queryPack.libraryPathDependencies;
                    if (libraryPathDependencies && libraryPathDependencies instanceof Array) {
                        libraryPathDependencies.push(queryExtensionPack.name);
                    }
                    else {
                        libraryPathDependencies = [queryExtensionPack.name];
                    }
                    queryPack.libraryPathDependencies = libraryPathDependencies;
                    core.info('Adding library dependency "' + queryExtensionPack.name + '" to QL pack "' + file + '"');
                    fs.writeFile(file, yaml.safeDump(queryPack), (err) => {
                        if (err) {
                            throw Error("Failed to update qlpack at: '" + file + "', because of error: " + err);
                        }
                    });
                }
            }
        }
    }
    ;
    core.endGroup();
}
exports.rewriteDefaultQueries = rewriteDefaultQueries;
//# sourceMappingURL=rewrite-queries.js.map