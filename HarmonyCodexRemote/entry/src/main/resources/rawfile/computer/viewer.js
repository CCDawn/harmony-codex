(() => {
  'use strict';
  const $ = id => document.getElementById(id);
  let identity = null, binding = null, pc = null, dc = null, generation = 0;
  let mode = 'offline', suspended = true, ended = false, polling = null, timeout = null, requestTimer = null;
  let scrollMode = false, lastScrollAt = 0;
  let hasFrames = false, requestSequence = 0, lastPointer = null, composing = false;
  const pending = new Map(), heldKeys = new Set(), physicalKeys = new Map();
  const video = $('video');
  const labels = {
    connecting:['正在连接','输入已停用'], observe:['观看中','助手正在控制'],
    pending:['正在请求接管','等待服务器确认'], control:['你已接管','你正在控制'],
    releasing:['正在归还控制','输入已停用'], offline:['连接已断开','输入已停用'],
    paused:['画面已暂停','输入已停用']
  };
  function render(next, hint) {
    mode = next;
    const labelsForMode = labels[next];
    $('status').textContent = labelsForMode[0]; $('owner').textContent = labelsForMode[1];
    if (hint) $('hint').textContent = hint;
    $('control').textContent = next === 'control' ? '归还控制权' : next === 'pending' ? '取消接管' : '接管电脑';
    $('control').disabled = !['observe','pending','control'].includes(next);
    $('keyboard').disabled = next !== 'control';
    $('scrollMode').disabled = next !== 'control';
    if (next !== 'control') {scrollMode = false;$('scrollMode').textContent = '滚动';}
    $('textInput').disabled = next !== 'control';
    $('sendText').disabled = next !== 'control';
    document.querySelectorAll('[data-key]').forEach(b => b.disabled = next !== 'control');
    if (next !== 'control') $('keyboardPanel').hidden = true;
    $('reconnect').hidden = next !== 'offline';
    $('cover').hidden = ['observe','pending','control','releasing'].includes(next) && hasFrames;
    $('coverTitle').textContent = labelsForMode[0];
    $('coverHint').textContent = next === 'connecting' ? '等待画面与数据通道就绪' : '恢复后只观看，不自动接管';
  }
  function request(operation, payload = {}) {
    return new Promise((resolve,reject) => {
      const id = String(++requestSequence);
      const timer = setTimeout(() => {pending.delete(id);reject(new Error('云电脑请求超时'));}, 50000);
      pending.set(id,{resolve,reject,timer});
      try { window.ComputerNative.request(id, operation, JSON.stringify(payload)); }
      catch (_) {clearTimeout(timer);pending.delete(id);reject(new Error('电脑连接组件不可用'));}
    });
  }
  function reply(id, ok, text) {
    const item = pending.get(id); if (!item) return;
    clearTimeout(item.timer);pending.delete(id);
    if (!ok) {item.reject(new Error(text));return;}
    try {item.resolve(JSON.parse(text));} catch (_) {item.reject(new Error('无效连接响应'));}
  }
  function sameBinding(value) {
    return value && value.assistantId === identity.assistantId && value.roomId === identity.roomId
      && (!binding || (value.threadId === binding.threadId && value.environmentId === binding.environmentId));
  }
  function sendEvent(event) { if (dc?.readyState === 'open') dc.send(JSON.stringify({event})); }
  function input(frame) {
    if (mode !== 'control' || suspended || dc?.readyState !== 'open' || !hasFrames) return;
    dc.send(frame);
  }
  function key(name, down) {
    if (!window.ComputerProtocol) return;
    input(window.ComputerProtocol.key(name, down));
    if (down) heldKeys.add(name); else heldKeys.delete(name);
  }
  function releaseInputs() {
    for (const name of heldKeys) key(name, false);
    heldKeys.clear(); physicalKeys.clear(); lastPointer = null;
  }
  function stopConnection() {
    releaseInputs();
    if (['pending','control','releasing'].includes(mode)) sendEvent('control/release');
    generation++;
    clearInterval(polling);clearTimeout(timeout);clearTimeout(requestTimer);
    for (const item of pending.values()) {clearTimeout(item.timer);item.reject(new Error('连接已关闭'));}
    pending.clear();
    const oldPc = pc, oldDc = dc; pc = null;dc = null;
    if (oldDc) {oldDc.onclose = null;oldDc.onmessage = null;oldDc.close();}
    if (oldPc) {oldPc.onconnectionstatechange = null;oldPc.close();}
    video.pause();video.srcObject = null;hasFrames = false;
    $('textInput').value = '';
  }
  function fail(message) { stopConnection(); render('offline', message); }
  function ready() {
    if (mode === 'connecting' && hasFrames && dc?.readyState === 'open') {
      clearTimeout(timeout);render('observe','仅观看。需要操作时，先接管电脑。');
    }
  }
  async function connect() {
    if (suspended || ended || !identity) return;
    stopConnection(); binding = null;
    const revision = generation;
    render('connecting','正在核对当前助手的云电脑…');
    try {
      const status = await request('status');
      if (revision !== generation) return;
      if (!sameBinding(status) || !status.ready || !status.threadId || !status.environmentId) throw new Error('当前助手的云电脑尚未就绪');
      binding = status;
      const peer = new RTCPeerConnection();pc = peer;
      peer.addTransceiver('audio',{direction:'recvonly'});
      peer.addTransceiver('video',{direction:'recvonly'});
      const channel = peer.createDataChannel('');dc = channel;
      channel.onopen = ready;
      channel.onclose = () => {if (revision === generation) fail('控制通道已断开，请重新连接。');};
      channel.onmessage = event => {
        if (revision !== generation || typeof event.data !== 'string') return;
        let message;try {message = JSON.parse(event.data);}catch (_) {return;}
        if (message.event === 'control/locked') {
          if (mode === 'pending' && !suspended) {clearTimeout(requestTimer);render('control','已获得控制权。完成后请归还。');}
          else sendEvent('control/release');
        } else if (message.event === 'control/release') {
          releaseInputs();clearTimeout(requestTimer);
          if (hasFrames) render('observe','控制权已归还。');
        }
      };
      peer.ontrack = event => {
        if (revision !== generation || event.track.kind !== 'video') return;
        video.srcObject = event.streams[0] || new MediaStream([event.track]);
        event.track.onended = () => {if (revision === generation) fail('远程画面已停止，请重新连接。');};
        video.play().catch(() => {if (revision === generation) fail('画面无法播放，请重新连接。');});
      };
      peer.onconnectionstatechange = () => {
        if (revision === generation && ['failed','disconnected','closed'].includes(peer.connectionState)) fail('云电脑连接中断，输入已停止。');
      };
      timeout = setTimeout(() => {if (revision === generation) fail('未收到可播放的画面，请重新连接。');},30000);
      const offer = await peer.createOffer();
      await peer.setLocalDescription(offer);
      // Send a complete offer: this protocol has no separate trickle-ICE route.
      if (peer.iceGatheringState !== 'complete') await new Promise(resolve => {
        const timer = setTimeout(done, 5000);
        function done() {clearTimeout(timer);peer.removeEventListener('icegatheringstatechange',change);resolve();}
        function change() {if (peer.iceGatheringState === 'complete') done();}
        peer.addEventListener('icegatheringstatechange',change);
      });
      if (revision !== generation) return;
      const answer = await request('session',{threadId:binding.threadId,environmentId:binding.environmentId,sdp:peer.localDescription.sdp});
      if (revision !== generation) return;
      if (!sameBinding(answer) || typeof answer.sdp !== 'string' || !answer.sdp.startsWith('v=0')) throw new Error('云电脑身份或连接响应发生变化');
      await peer.setRemoteDescription({type:'answer',sdp:answer.sdp});
      let ticks = 0, busy = false;
      polling = setInterval(async () => {
        if (busy || revision !== generation) return;busy = true;
        try {
          const stats = await peer.getStats();
          if (revision !== generation) return;
          stats.forEach(s => {if (s.type === 'inbound-rtp' && s.kind === 'video' && s.framesDecoded > 0) hasFrames = true;});
          ready();
          if (++ticks % 10 === 0) {
            const current = await request('status');
            if (revision === generation && (!sameBinding(current) || !current.ready)) fail('助手或云环境已变化，请返回对话后重新打开。');
          }
        } catch (_) {if (revision === generation) fail('无法核对云电脑状态，连接已停止。');}
        finally {busy = false;}
      },1000);
    } catch (error) {if (revision === generation) fail(error.message || '连接失败，请重试。');}
  }
  function relinquish() {
    releaseInputs();clearTimeout(requestTimer);
    render('releasing','已停止本地输入，等待归还确认…');sendEvent('control/release');
    requestTimer = setTimeout(() => fail('未收到归还确认，已关闭连接。'),5000);
  }
  $('control').onclick = () => {
    if (mode === 'observe') {
      render('pending','等待服务器确认，确认前不能输入。');sendEvent('control/request');
      requestTimer = setTimeout(() => {if (mode === 'pending') relinquish();},10000);
    } else if (mode === 'control' || mode === 'pending') relinquish();
  };
  $('reconnect').onclick = connect;
  $('keyboard').onclick = () => {if (mode === 'control') {$('keyboardPanel').hidden = !$('keyboardPanel').hidden;if (!$('keyboardPanel').hidden) $('textInput').focus();}};
  function suspend() {
    stopConnection();suspended = true;render('paused','已停止输入、请求归还控制并暂停画面。');
  }
  function resume() {
    if (ended || !suspended) return;
    suspended = false;connect();
  }
  window.addEventListener('blur',() => {if (mode === 'control' || mode === 'pending') relinquish();});
  // Foreground resumption is owned by UIAbility, not a possibly earlier WebView
  // visibility event (the native bridge still rejects requests while backgrounded).
  document.addEventListener('visibilitychange',() => {if (document.hidden) suspend();});
  window.addEventListener('pagehide',suspend);
  window.computerViewer = {
    configure(assistantId,roomId,dark) {identity = {assistantId,roomId};document.body.classList.toggle('dark',dark);},
    reply,suspend,resume,
    close() {ended = true;suspend();}
  };
  // Input encoding lives separately so coordinates and wire bytes can be verified.
  function coordinates(event) {
    const r = video.getBoundingClientRect(), w = video.videoWidth, h = video.videoHeight;
    if (!w || !h) return null;
    const scale = Math.min(r.width/w,r.height/h), left = r.left+(r.width-w*scale)/2, top = r.top+(r.height-h*scale)/2;
    const x = (event.clientX-left)/scale,y = (event.clientY-top)/scale;
    return x < 0 || y < 0 || x >= w || y >= h ? null : {x:Math.floor(x),y:Math.floor(y)};
  }
  video.addEventListener('pointerdown',event => {
    if (mode !== 'control') return;const point = coordinates(event);if (!point) return;
    if (lastPointer || event.button < 0 || event.button > 2) return;
    event.preventDefault();video.focus();
    const button = 'Pointer_Button' + (event.button + 1);
    lastPointer = {id:event.pointerId,button,point,clientX:event.clientX,clientY:event.clientY};
    video.setPointerCapture(event.pointerId);
    input(window.ComputerProtocol.move(point.x,point.y));if (!scrollMode) key(button,true);
  });
  video.addEventListener('pointermove',event => {
    if (mode !== 'control') return;
    if (scrollMode && lastPointer?.id === event.pointerId) {
      sendScroll(lastPointer.clientX-event.clientX,lastPointer.clientY-event.clientY);
      lastPointer.clientX=event.clientX;lastPointer.clientY=event.clientY;return;
    }
    const point=coordinates(event);if (point) input(window.ComputerProtocol.move(point.x,point.y));
  });
  function pointerUp(event) {if (lastPointer?.id === event.pointerId) {if (!scrollMode) key(lastPointer.button,false);lastPointer=null;}}
  video.addEventListener('pointerup',pointerUp);video.addEventListener('pointercancel',pointerUp);
  video.addEventListener('lostpointercapture',pointerUp);
  video.addEventListener('wheel',event => {if (mode !== 'control') return;const p=coordinates(event);if (!p)return;event.preventDefault();input(window.ComputerProtocol.move(p.x,p.y));const scale=event.deltaMode===0?1:19;sendScroll(event.deltaX*scale,event.deltaY*scale);},{passive:false});
  function sendScroll(x,y) {if (Date.now()-lastScrollAt<100) return;lastScrollAt=Date.now();input(window.ComputerProtocol.scroll(x,y));}
  $('scrollMode').onclick=()=>{if(mode!=='control')return;releaseInputs();scrollMode=!scrollMode;$('scrollMode').textContent=scrollMode?'结束滚动':'滚动';};
  video.addEventListener('contextmenu',event=>event.preventDefault());
  document.querySelectorAll('[data-key]').forEach(button => button.onclick=()=>{key(button.dataset.key,true);key(button.dataset.key,false);});
  $('textInput').addEventListener('compositionstart',()=>composing=true);
  $('textInput').addEventListener('compositionend',()=>composing=false);
  $('sendText').onclick=()=>{if(mode!=='control'||composing)return;for(const ch of $('textInput').value.slice(0,1000)){key(ch,true);key(ch,false);}$('textInput').value='';};
  video.addEventListener('keydown',event=>{
    if(mode!=='control'||event.isComposing)return;
    const code=event.code||event.key;
    const name=physicalKeys.get(code)||window.ComputerProtocol.keyName(event);
    if(name){event.preventDefault();physicalKeys.set(code,name);key(name,true);}
  });
  video.addEventListener('keyup',event=>{
    const code=event.code||event.key,name=physicalKeys.get(code);
    if(name){event.preventDefault();physicalKeys.delete(code);key(name,false);}
  });
})();
