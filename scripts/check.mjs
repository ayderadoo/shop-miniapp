import { readdirSync, readFileSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
const dir=mkdtempSync(join(tmpdir(),'ramp-check-'));
let failures=0;
function check(path,code,ts=false) {
 const target=code===null ? path : join(dir,path.replaceAll('/','-')+'.js');
 if(code!==null)writeFileSync(target,code);
 const result=spawnSync(process.execPath,[...(ts?['--experimental-transform-types']:[]),'--check',target],{encoding:'utf8'});
 if(result.status){failures++;console.error(path,result.stderr);}else console.log('OK',path);
}
function walk(dir) {return readdirSync(dir,{withFileTypes:true}).flatMap(f=>f.isDirectory()?walk(join(dir,f.name)):[join(dir,f.name)]);}
try {
 for(const path of ['index.html','admin.html']) check(path,[...readFileSync(path,'utf8').matchAll(/<script>([\s\S]*?)<\/script>/g)].map(m=>m[1]).join('\n'));
 for(const path of walk('assets').filter(p=>p.endsWith('.js')))check(path,null);
 for(const path of walk('supabase/functions').filter(p=>p.endsWith('.ts')))check(path,null,true);
} finally {rmSync(dir,{recursive:true,force:true});}
process.exitCode=failures?1:0;
