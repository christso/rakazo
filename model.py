import json,time
from http.server import BaseHTTPRequestHandler,HTTPServer
from pathlib import Path
ROOT=Path('/lab')
def resources(value):
    if isinstance(value,dict):
        if 'computerResources' in value:return value['computerResources']
        if 'memoryPercent' in value and 'memoryUsedBytes' in value:return value
        for v in value.values():
            found=resources(v)
            if found:return found
    elif isinstance(value,list):
        for v in value:
            found=resources(v)
            if found:return found
    elif isinstance(value,str):
        try:return resources(json.loads(value))
        except (ValueError,TypeError):pass
    return None
class Handler(BaseHTTPRequestHandler):
    def do_GET(self):
        self.send_response(200);self.send_header('Content-Type','application/json');self.end_headers()
        self.wfile.write(json.dumps({'data':[{'id':'resource-lab-policy','object':'model','context_length':64000}]}).encode())
    def do_POST(self):
        b=json.loads(self.rfile.read(int(self.headers['Content-Length'])))
        with (ROOT/'requests.jsonl').open('a') as f:f.write(json.dumps(b)+'\n')
        self.send_response(200);self.send_header('Content-Type','text/event-stream');self.end_headers()
        def emit(delta,finish=None):
            self.wfile.write(('data: '+json.dumps({'id':'lab-response','object':'chat.completion.chunk','created':0,'model':b['model'],'choices':[{'index':0,'delta':delta,'finish_reason':finish}]})+'\n\n').encode())
        emit({'role':'assistant'})
        messages=b.get('messages',[])
        user=next((m for m in reversed(messages) if m['role']=='user'),{})
        last=messages[-1] if messages else {}
        reply='Synthetic policy emulator ready. No language-model reasoning is being tested.'
        call=None
        if 'Inspect the local test page' in json.dumps(user.get('content','')):
            if last.get('role')!='tool':
                call=('lab-inspect','shell',{'command':'python3 -c \'import urllib.request; print(urllib.request.urlopen("http://127.0.0.1:8765").read().decode())\''})
            elif last.get('tool_call_id')=='lab-check':
                data=resources(last.get('content'))
                previous=[resources(m.get('content')) for m in messages if m.get('role')=='tool']
                high=next((v for v in reversed(previous) if v and v.get('memoryPressure')),None)
                if not data:raise RuntimeError('Fresh computer_resources result missing')
                reply=f"AFTER: Automatic feedback reported {high['memoryPercent'] if high else '?'}% RAM pressure. Stopped only the fixture-owned unused workload. Fresh resource check: {data['memoryPercent']}% RAM, {data['cpuPercent']}% CPU. The fixture page remains available."
            elif last.get('tool_call_id')=='lab-cleanup':
                call=('lab-check','use_tool',{'name':'computer_resources','arguments':{}})
            else:
                data=resources(last.get('content'))
                with (ROOT/'observed-resources.jsonl').open('a') as f:f.write(json.dumps({'time':time.time(),'data':data,'last':last})+'\n')
                if data and (data.get('memoryPercent',0)>=85 or data.get('memoryPressure') in (True,'high')):
                    call=('lab-cleanup','shell',{'command':'python3 -c \'import os,signal; from pathlib import Path; os.kill(int(Path("/tmp/resource-lab-unused-work.pid").read_text()),signal.SIGTERM); print("Stopped fixture-owned unused workload only"); import urllib.request; print(urllib.request.urlopen("http://127.0.0.1:8765").read().decode())\''})
                else:
                    reply='BEFORE: The local test page is available. This tool result contains no automatic RAM-pressure warning, so the synthetic policy has no resource signal to trigger cleanup. The unused fixture workload is still running.'
        if call:
            ident,name,args=call
            emit({'tool_calls':[{'index':0,'id':ident,'type':'function','function':{'name':name,'arguments':json.dumps(args)}}]});emit({},'tool_calls')
        else:emit({'content':reply});emit({},'stop')
        self.wfile.write(b'data: [DONE]\n\n')
HTTPServer(('0.0.0.0',8080),Handler).serve_forever()
