from pathlib import Path
import argparse,datetime,hashlib,json,os,subprocess,time,sys
stage=Path(__file__).resolve().parent
p=argparse.ArgumentParser();p.add_argument('--name',required=True);p.add_argument('--cwd',default=str(Path.cwd()));p.add_argument('--env-json');p.add_argument('command',nargs=argparse.REMAINDER);a=p.parse_args()
assert '/' not in a.name and '..' not in a.name
cmd=a.command[1:] if a.command[:1]==['--'] else a.command
selected=json.loads(Path(a.env_json).read_text()) if a.env_json else {}
env={k:v for k,v in os.environ.items() if k.lower() not in ('http_proxy','https_proxy','all_proxy')};env.update(selected)
log=stage/'logs'/(a.name+'.log');start=datetime.datetime.now(datetime.timezone.utc).isoformat();timer=time.monotonic()
with log.open('xb') as out:r=subprocess.run(cmd,cwd=a.cwd,env=env,stdout=out,stderr=subprocess.STDOUT)
record={'started_at':start,'finished_at':datetime.datetime.now(datetime.timezone.utc).isoformat(),'duration_seconds':time.monotonic()-timer,'cwd':a.cwd,'argv':cmd,'explicit_environment':selected,'proxy_environment_removed':True,'exit_code':r.returncode,'log':{'path':'logs/'+log.name,'size_bytes':log.stat().st_size,'sha256':hashlib.sha256(log.read_bytes()).hexdigest()}}
(stage/'receipts'/(a.name+'.json')).write_text(json.dumps(record,indent=2)+'\n');print(json.dumps(record));print(log.read_text(errors='replace')[-7000:]);sys.exit(r.returncode)
