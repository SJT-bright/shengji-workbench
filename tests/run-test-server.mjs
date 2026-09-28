import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
const dir=fs.mkdtempSync(path.join(os.tmpdir(),'shengji-ui-'));
process.env.SHENGJI_PORT='5196';process.env.SHENGJI_DATA_DIR=path.join(dir,'data');process.env.SHENGJI_INBOX=path.join(dir,'inbox');process.env.SHENGJI_TOKEN='ui-test-token';process.env.SHENGJI_AI_ENDPOINT='http://127.0.0.1:9/api/chat';
process.on('exit',()=>fs.rmSync(dir,{recursive:true,force:true}));
await import('../server.mjs');
