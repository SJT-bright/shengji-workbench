import {defineConfig} from '@playwright/test';
const port=process.env.SHENGJI_UI_TEST_PORT||'5196';
export default defineConfig({testDir:'./tests',testMatch:['workbench.spec.js','retrieval-ui.spec.js','release.spec.js'],use:{baseURL:`http://127.0.0.1:${port}`,headless:true,channel:'chrome'},workers:1,webServer:{command:'node tests/run-test-server.mjs',url:`http://127.0.0.1:${port}/api/health`,reuseExistingServer:false}});
