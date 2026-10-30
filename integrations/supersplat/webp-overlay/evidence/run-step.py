"""Exclusive, resumable-by-new-step-name evidence runner for isolated WebP work."""
from pathlib import Path
import argparse
import datetime
import hashlib
import json
import os
import subprocess
import sys
import time

out = Path(__file__).resolve().parent
root = out.parents[2]
parser = argparse.ArgumentParser()
parser.add_argument('--name', required=True)
parser.add_argument('--cwd', default=str(root))
parser.add_argument('--env-json')
parser.add_argument('command', nargs=argparse.REMAINDER)
args = parser.parse_args()
command = args.command[1:] if args.command[:1] == ['--'] else args.command
assert command and '/' not in args.name and '..' not in args.name
environment = os.environ.copy()
selected = json.loads(Path(args.env_json).read_text()) if args.env_json else {}
environment.update(selected)
start = datetime.datetime.now(datetime.timezone.utc).isoformat()
timer = time.monotonic()
log = out / 'logs' / (args.name + '.log')
with log.open('xb') as stream:
    result = subprocess.run(command, cwd=args.cwd, env=environment, stdout=stream, stderr=subprocess.STDOUT)
receipt = {
    'started_at': start, 'finished_at': datetime.datetime.now(datetime.timezone.utc).isoformat(),
    'duration_seconds': time.monotonic() - timer, 'cwd': args.cwd, 'argv': command,
    'explicit_environment': selected, 'exit_code': result.returncode,
    'log': {'path': str(log), 'size_bytes': log.stat().st_size, 'sha256': hashlib.sha256(log.read_bytes()).hexdigest()}
}
with (out / 'receipts' / (args.name + '.json')).open('x') as stream:
    json.dump(receipt, stream, indent=2)
    stream.write('\n')
print(json.dumps(receipt), flush=True)
print(log.read_text(errors='replace')[-9000:], flush=True)
sys.exit(result.returncode)
