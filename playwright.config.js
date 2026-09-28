import {defineConfig} from '@playwright/test';
export default defineConfig({testDir:'./tests',testMatch:'workbench.spec.js',use:{baseURL:'http://127.0.0.1:5196',headless:true,channel:'chrome'},workers:1,webServer:{command:'node tests/run-test-server.mjs',url:'http://127.0.0.1:5196/api/health',reuseExistingServer:false}});
