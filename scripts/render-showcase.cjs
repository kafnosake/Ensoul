// Captures the built renderer with fictional, isolated data. No agents or plugins run.
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const root = path.resolve(__dirname, '..');

if (!process.versions.electron) {
  const { spawnSync } = require('node:child_process');
  const local = path.join(root, '.electron', `${process.platform}-${process.arch}`, process.platform === 'win32' ? 'electron.exe' : 'electron');
  const executable = fs.existsSync(local) ? local : require('electron');
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  const result = spawnSync(executable, [__filename], { env, stdio: 'inherit', windowsHide: true });
  process.exit(result.status ?? 1);
} else {
  const { app, BrowserWindow, ipcMain } = require('electron');
  const out = path.join(root, '.ensoul', 'tmp', 'showcase-v3');
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'ensoul-showcase-'));
  app.setPath('userData', userData);
  app.commandLine.appendSwitch('force-device-scale-factor', '1');

  const ZOOM = 1.25;
  const now = Date.now();
  const msg = (role, content, i) => ({ id: 'message-'+i, role, content, createdAt: now+i*1000 });
  const panel = (id, title, kind, chat=[]) => ({
    id, title, kind, chat, origin:'user', createdAt:now, updatedAt:now,
    look:{accent:'#5b8cff',density:'normal',showChat:kind==='chat'},
    spec:{body:'messages',text:'',systemPrompt:'',actions:[],fields:[]}, revisions:[],
  });
  const tabs = (id, ids) => ({type:'tabs',id,panels:ids,active:ids[0]});
  const writer = panel('writing','写作','chat',[
    msg('user','陪我写好这段介绍。',1),
    msg('assistant','没问题。把待办挂在旁边，随时看一眼。',2),
  ]);
  const clock = panel('clock','今日待办','todo');
  const worker = panel('editor-work','文案编辑','chat'); worker.hidden=true;
  const board = panel('board','便利贴','notes');
  const model = {pick:'example::default',model:'默认模型',provider:'示例提供方',name:'默认模型',hasKey:true};
  const editor={id:'editor',name:'文案编辑',dept:'内容组',company:'我的工作室',role:'worker',avatar:'',accent:'#9778cc',model:'默认模型',panel:worker.id,open:true,shown:false,status:'idle',count:0,at:now,last:null};
  const staff={contacts:[],opens:{}};
  const pins=[{id:'task',text:'写三句介绍。',at:now,rotation:-1,color:'#fef08a',pinColor:'#536dfe'}];
  let ws={workspace:'D:\\ensoul-demo',panels:{writing:writer,clock},layout:tabs('writing-tabs',['writing']),floating:[],widgets:[],models:{writing:model,clock:model,'editor-work':model},componentRefs:[],status:{}};
  const files={
    '.ensoul/state/memo/board.json':JSON.stringify(pins),
    '.ensoul/state/eschat.json':JSON.stringify(staff),
    '.ensoul/state/dispatch.inbox.json':'{"entries":[]}',
    '.ensoul/state/todo.json':JSON.stringify({panels:{clock:{title:'今日待办',items:[{content:'整理思路',status:'completed'},{content:'写好介绍',status:'pending'}]}}}),
  };
  const plugins=['todo','notes'].map(name=>({name,enabled:true,panel:{kind:name,label:name==='notes'?'便利贴':'待办',body:'messages'}}));
  let win, floating;
  const channels=[...fs.readFileSync(path.join(root,'src/preload/index.ts'),'utf8').matchAll(/invoke\('([^']+)'/g)].map(m=>m[1]);
  const broadcast=()=>win.webContents.send('ws:state',ws);
  for(const channel of new Set(channels))ipcMain.handle(channel,(_e,...args)=>{
    switch(channel){
      case 'ws:state':return ws;
      case 'panel:body':return ws.panels[args[0]];
      case 'ext:list':return {plugins,skills:[]};
      case 'fs:read':return files[args[0]]||'{}';
      case 'fs:readJson':return files[args[0]] ? {status:'ready',data:JSON.parse(files[args[0]])} : {status:'missing'};
      case 'fs:write':files[args[0]]=args[1];return {ok:true};
      case 'fs:root':return ws.workspace;
      case 'ui:lang:get':return 'zh';
      case 'ui:zoom:get':return ZOOM;
      case 'win:isLive':return false;
      case 'model:get':return model;
      case 'model:catalog':return [{key:'example',label:'示例提供方',hasKey:true,models:[{id:'default',name:'默认模型'}]}];
      case 'settings:get':return {workspace:ws.workspace};
      case 'chat:askState':case 'chat:liveState':return null;
      case 'chat:outbox':return {messages:[],steer:[]};
      case 'panel:patch':Object.assign(ws.panels[args[0]],args[1]);broadcast();return ws.panels[args[0]];
      case 'panel:create':{
        const next=panel('new','新面板','chat');
        ws.panels.new=next;ws.models.new=model;ws.layout.panels.push('new');ws.layout.active='new';broadcast();return next;
      }
      case 'chat:send':{
        if(args[0]!==worker.id)throw Error('Only the fictional employee can receive demo messages');
        worker.status='working';worker.chat=[msg('user',args[1],3)];
        editor.status='working';editor.last={role:'user',text:args[1]};
        files['.ensoul/state/eschat.json']=JSON.stringify(staff);broadcast();return {ok:true};
      }
      default:return [];
    }
  });
  const delay=ms=>new Promise(r=>setTimeout(r,ms));
  const options=(width,height)=>({width,height,useContentSize:true,frame:false,show:false,skipTaskbar:true,webPreferences:{preload:path.join(root,'dist/preload/index.js'),sandbox:true,contextIsolation:true,nodeIntegration:false,offscreen:true}});
  const load=async(w,query)=>{
    await w.loadFile(path.join(root,'dist/renderer/index.html'),{query});
    w.webContents.setZoomFactor(ZOOM);
    await delay(500);
  };
  const reload=async()=>{
    const loaded=new Promise(r=>win.webContents.once('did-finish-load',r));
    win.webContents.reload();await loaded;win.webContents.setZoomFactor(ZOOM);await delay(500);
  };
  const capture=async(name,w=win)=>{
    await delay(500);
    fs.writeFileSync(path.join(out,name+'.png'),(await w.webContents.capturePage()).toPNG());
    console.log('Captured '+name);
  };
  const rect=async(selector)=>win.webContents.executeJavaScript('(()=>{const r=document.querySelector('+JSON.stringify(selector)+').getBoundingClientRect();const z='+ZOOM+';return {x:r.x*z,y:r.y*z,width:r.width*z,height:r.height*z}})()');
  app.whenReady().then(async()=>{
    fs.mkdirSync(out,{recursive:true});
    win=new BrowserWindow(options(1280,820));
    await load(win,{mode:'main'});
    await win.webContents.executeJavaScript("localStorage.setItem('ensoul.theme','light');localStorage.setItem('ensoul_show_monitor','false');for(const id of ['writing','new','editor-work'])localStorage.setItem('histconv.rail.'+id,'0');");
    await reload();
    await capture('open-before');
    const plus=await rect('.tab-add');
    await win.webContents.executeJavaScript("document.querySelector('.tab-add').click()");
    await capture('open-after');
    ws.layout.active='writing';broadcast();await delay(150);
    await capture('embed-before');
    ws.floating=[{id:'tool-window',rect:{x:0,y:0,width:360,height:300},root:tabs('tool-tabs',['clock'])}];
    floating=new BrowserWindow(options(360,300));
    await load(floating,{mode:'floating',window:'tool-window'});
    await capture('tool-window',floating);
    const group=await win.webContents.executeJavaScript("(()=>{const r=document.querySelector('.tabs-group').getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2}})()");
    win.webContents.send('drop:probe',{id:1,x:group.x,y:group.y,draw:true,whole:true});
    await delay(150);await capture('embed-target');
    const target=await rect('.zone-box');
    win.webContents.send('drop:probe:end');ws.floating=[];
    clock.float={host:'main',anchor:'writing-tabs',rx:.7,ry:.46,width:275,height:230,locked:true};
    broadcast();await capture('embed-after');
    const embedded=await rect('.float-panel');
    floating.destroy();
    staff.contacts=[editor];files['.ensoul/state/eschat.json']=JSON.stringify(staff);
    ws={...ws,panels:{board,[worker.id]:worker},layout:tabs('board-tabs',['board']),floating:[]};
    await win.webContents.executeJavaScript("localStorage.setItem('ensoul_sidebar_expanded','true');localStorage.setItem('ensoul_note_zoom_board','1.6');localStorage.setItem('ensoul_show_monitor','true');");
    await reload();await capture('dispatch-before');
    await win.webContents.executeJavaScript('(()=>{const card=document.querySelector(".note-pin-card"),employee=document.querySelector(".sbm-item[data-unit-id=editor]"),dt=new DataTransfer();card.dispatchEvent(new DragEvent("dragstart",{bubbles:true,cancelable:true,dataTransfer:dt}));employee.dispatchEvent(new DragEvent("dragenter",{bubbles:true,cancelable:true,dataTransfer:dt}));window.showcaseDrag={dt,card,employee};})()');
    const from=await rect('.note-pin-card'),to=await rect('.sbm-item[data-unit-id="editor"]');
    await capture('dispatch-target');
    await win.webContents.executeJavaScript("(()=>{const {dt,card,employee}=window.showcaseDrag;employee.dispatchEvent(new DragEvent('drop',{bubbles:true,cancelable:true,dataTransfer:dt}));card.dispatchEvent(new DragEvent('dragend',{bubbles:true,dataTransfer:dt}));})()");
    await delay(700);
    if(worker.status!=='working')throw Error('The renderer did not deliver the demo note');
    worker.hidden=false;
    await win.webContents.executeJavaScript("window.dispatchEvent(new CustomEvent('ensoul:monitor-set',{detail:false}))");
    ws.layout={type:'split',id:'receipt',direction:'row',ratio:.57,children:[tabs('employee-tabs',[worker.id]),tabs('board-tabs',['board'])]};
    broadcast();await capture('dispatch-received');
    worker.status='idle';worker.chat.push(msg('assistant','完成了三句介绍。\n\n已交回执，原便利贴已盖章。',4));
    const delivered=JSON.parse(files['.ensoul/state/memo/board.json']);
    delivered[0].done={at:now+4000,by:editor.name,empId:editor.id,panelId:worker.id};
    files['.ensoul/state/memo/board.json']=JSON.stringify(delivered);
    editor.status='idle';editor.last={role:'assistant',text:'介绍已完成。'};
    files['.ensoul/state/eschat.json']=JSON.stringify(staff);broadcast();
    await delay(1500);await capture('dispatch-after');
    fs.writeFileSync(path.join(out,'motion.json'),JSON.stringify({zoom:ZOOM,plus,target,embedded,from,to,receivedCard:await rect('.note-pin-card')}));
    win.destroy();app.quit();
  }).catch(e=>{console.error(e);app.exit(1)});
  setTimeout(()=>app.exit(2),30000).unref();
}
