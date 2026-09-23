import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';

const root=fileURLToPath(new URL('..',import.meta.url));
await build({
  absWorkingDir:root,entryPoints:['renderer/editor.mjs','renderer/output.mjs'],bundle:true,format:'esm',
  outdir:'dist',assetNames:'assets/[name]-[hash]',loader:{'.woff2':'file','.woff':'file','.ttf':'file','.svg':'file'},
  sourcemap:true,target:['chrome136'],logLevel:'info',
});
