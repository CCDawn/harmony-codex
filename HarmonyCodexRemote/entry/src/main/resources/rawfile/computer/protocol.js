/* Wire format verified against the installed desktop viewer:
 * uint8 kind, uint16 little-endian payload length, then the payload.
 * Key values use X11 keysyms; mouse buttons use 1/2/3.
 */
(function (root) {
  'use strict';
  const keys = {Pointer_Button1:1,Pointer_Button2:2,Pointer_Button3:3,
    BackSpace:0xff08,Tab:0xff09,Return:0xff0d,Escape:0xff1b,
    Delete:0xffff,Home:0xff50,End:0xff57,PageUp:0xff55,PageDown:0xff56,
    ArrowLeft:0xff51,ArrowUp:0xff52,ArrowRight:0xff53,ArrowDown:0xff54,
    Shift:0xffe1,Control:0xffe3,Alt:0xffe9,Meta:0xffeb,
    ShiftRight:0xffe2,ControlRight:0xffe4,AltRight:0xffea,MetaRight:0xffec,
    CapsLock:0xffe5,Insert:0xff63};
  function keysym(name) {
    if (Object.hasOwn(keys,name)) return keys[name];
    if (/^F([1-9]|1[0-2])$/.test(name)) return 0xffbd+Number(name.slice(1));
    const cp=String(name).codePointAt(0);
    if ([...String(name)].length !== 1) throw new Error('Unsupported key');
    if (cp <= 0x1f || (cp >= 0x7f && cp <= 0x9f)) return 0xff00 | cp;
    return cp <= 0xff ? cp : 0x01000000+cp;
  }
  function packet(kind,length) {const data=new DataView(new ArrayBuffer(3+length));data.setUint8(0,kind);data.setUint16(1,length,true);return data;}
  const clamp=(v,min,max)=>Math.min(max,Math.max(min,Math.round(v)));
  const protocol={
    move(x,y) {const v=packet(1,4);v.setUint16(3,clamp(x,0,65535),true);v.setUint16(5,clamp(y,0,65535),true);return v.buffer;},
    scroll(x,y) {const v=packet(2,4);v.setInt16(3,clamp(-x,-10,10),true);v.setInt16(5,clamp(-y,-10,10),true);return v.buffer;},
    key(name,down) {const v=packet(down?3:4,8);v.setBigUint64(3,BigInt(keysym(name)),true);return v.buffer;},
    keyName(event) {if(event.key==='Enter')return 'Return';if(event.key==='Backspace')return 'BackSpace';if(event.location===2&&['Shift','Control','Alt','Meta'].includes(event.key))return event.key+'Right';if(Object.hasOwn(keys,event.key)||/^F([1-9]|1[0-2])$/.test(event.key)||[...event.key].length===1)return event.key;return null;},
    keysym
  };
  root.ComputerProtocol=protocol;
})(typeof window==='undefined'?globalThis:window);
