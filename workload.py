import os,time,json,signal
from pathlib import Path
ROOT=Path('/sys/fs/cgroup')
limit=int((ROOT/'memory.max').read_text())
def used():
    values=dict(line.split() for line in (ROOT/'memory.stat').read_text().splitlines())
    return max(0,int((ROOT/'memory.current').read_text())-int(values.get('inactive_file',0)))
Path('/tmp/resource-lab-unused-work.pid').write_text(str(os.getpid()))
chunks=[]
for _ in range(200):
    chunks.append(bytearray(4*1024*1024))
    time.sleep(.01)
Path('/tmp/resource-lab-load-ready.json').write_text(json.dumps({'pid':os.getpid(),'workingSet':used(),'limit':limit,'chunks':len(chunks)}))
end=time.monotonic()+240
while time.monotonic()<end:
    sum(i*i for i in range(20000))
