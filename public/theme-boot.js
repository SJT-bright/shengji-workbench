/* 首帧主题引导：在样式应用前按「本地偏好 → 系统」设定 data-theme，避免深色用户闪白。
   与 main.js 的 THEME_KEY 保持一致；CSP 为 script-src 'self'，因此用外链文件而非内联脚本。 */
try{
 var mode=localStorage.getItem('shengji.theme')||'auto';
 var dark=mode==='dark'||(mode==='auto'&&window.matchMedia('(prefers-color-scheme: dark)').matches);
 document.documentElement.dataset.theme=dark?'dark':'light';
}catch(e){document.documentElement.dataset.theme='light'}
