import {CodexDesktopCdpClient} from '../src/codexDesktopCdpClient.js';
const c=new CodexDesktopCdpClient();try{await c.ensureConnected();console.log(JSON.stringify(await c.evaluate(`({electron:Object.keys(window.electron||{}),bridgeKeys:Object.keys(window).filter(k=>/scope|store|atom|jotai|auth/i.test(k))})`)));}finally{c.close();}
