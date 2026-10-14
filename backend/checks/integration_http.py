"""Temporary orchestration: actual HTTP with a labelled synthetic model provider."""
import http.server,json,os,socket,subprocess,sys,tempfile,threading,time
from pathlib import Path
import httpx

ROOT=Path(__file__).resolve().parents[2]
class Provider(http.server.BaseHTTPRequestHandler):
    def log_message(self,*args): pass
    def do_POST(self):
        payload=json.loads(self.rfile.read(int(self.headers['Content-Length'])))
        if payload['model']=='bad-auth':
            self.send_response(401);self.end_headers();return
        if payload['model']=='bad-format':
            output='not json'
        else:
            context=json.loads(payload['messages'][1]['content'])
            answer=context['current_answer']
            assessment='correct' if answer.startswith('栈顶') or '后进先出' in answer else 'incorrect'
            output=json.dumps({'assessment':assessment,'issue':'未检查实际栈顶' if assessment=='incorrect' else None,
                              'confidence':0.7,'evidence':answer,'reply':'请检查当前栈顶。'},ensure_ascii=False)
        body=json.dumps({'choices':[{'finish_reason':'stop','message':{'content':output}}]}).encode()
        self.send_response(200);self.send_header('Content-Type','application/json');self.send_header('Content-Length',str(len(body)));self.end_headers();self.wfile.write(body)

def free_port():
    with socket.socket() as s:s.bind(('127.0.0.1',0));return s.getsockname()[1]

provider=http.server.ThreadingHTTPServer(('127.0.0.1',0),Provider)
threading.Thread(target=provider.serve_forever,daemon=True).start()
with tempfile.TemporaryDirectory() as temporary:
    port=free_port();env=os.environ.copy()
    for name in ['HTTP_PROXY','HTTPS_PROXY','ALL_PROXY','http_proxy','https_proxy','all_proxy']:
        env.pop(name,None)
    env.update(DATABASE_PATH=str(Path(temporary)/'data'/'records.sqlite3'),LLM_API_KEY='',LLM_MODEL='',LLM_BASE_URL='',
               ROUNDTRIP_DIR=temporary,ROUNDTRIP_API=f'http://127.0.0.1:{port}',ROUNDTRIP_PROVIDER=f'http://127.0.0.1:{provider.server_port}/v1')
    try:
        for stage in ['initial','restart']:
            process=subprocess.Popen([sys.executable,'-m','uvicorn','app.main:app','--host','127.0.0.1','--port',str(port)],cwd=ROOT/'backend',env=env,stdout=subprocess.DEVNULL)
            try:
                with httpx.Client(trust_env=False) as client:
                    for attempt in range(100):
                        try:
                            if client.get(env['ROUNDTRIP_API']+'/health').status_code==200:break
                        except httpx.RequestError: pass
                        if process.poll() is not None: raise RuntimeError('backend exited')
                        time.sleep(.05)
                    else:raise RuntimeError('backend readiness timeout')
                subprocess.run(['node',str(ROOT/'frontend'/'tests'/'integration-http.cjs'),stage],env=env,check=True)
            finally:
                process.terminate();process.wait(timeout=10)
    finally:
        provider.shutdown();provider.server_close()
print('Actual frontend adapter -> FastAPI -> synthetic Chat Completions -> SQLite -> restart: passed.')
