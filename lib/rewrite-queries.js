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
const util = __importStar(require("./util"));
async function rewriteDefaultQueries(codeqlCmd) {
    const workspace = util.workspaceFolder();
    const rewriteFolder = path.join(workspace, 'rewritten-default-queries');
    await io.mkdirP(rewriteFolder);
    core.info('Collecting default queries');
    let qlpacks = '';
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
    for (const [qlpack, paths] of Object.entries(qlpacksDictionary)) {
        const qlpackFolder = path.join(rewriteFolder, qlpack);
        await io.mkdirP(qlpackFolder);
        const options = { recursive: true, force: false };
        await io.cp(paths[0], qlpackFolder, options);
    }
    core.info('Rewriting default Java queries');
    const globber = glob.create(rewriteFolder + '/*java*/**/*.ql');
    for await (const file of (await globber).globGenerator()) {
        fs.readFile(file, 'utf8', (err, query) => {
            if (err) {
                throw new Error('Unable to read the default query "' + file + '" for rewriting');
            }
            if (query.search("@kind path-problem") !== -1) {
                const rewrittenQuery = query.replace('import DataFlow::PathGraph', "import DataFlow::PathGraph\nimport Extensions::AdditionalTaintSteps");
                fs.writeFile(file, rewrittenQuery, (err) => {
                    if (err) {
                        throw new Error('Unable to write the default query "' + file + '" with rewritten content');
                    }
                });
            }
        });
    }
}
exports.rewriteDefaultQueries = rewriteDefaultQueries;
//# sourceMappingURL=rewrite-queries.js.map