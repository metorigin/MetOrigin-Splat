from pathlib import Path
import copy,datetime,difflib,gzip,hashlib,json,re,shutil
root=Path(__file__).resolve().parents[1].parent
stage=Path(__file__).resolve().parent
oldroot=root/'integrations/supersplat/webp-overlay'
out=root/'integrations/supersplat/webp-overlay-3.10.2'
old=json.loads((oldroot/'build-evidence.json').read_text())
profile='splat-transform-3.10.2-webp-1.6.0-emscripten-4.0.21-v1'
sha=lambda b:hashlib.sha256(b).hexdigest()
def record(p,rel=None):
 b=p.read_bytes();return {'path':rel or str(p.relative_to(stage)),'size_bytes':len(b),'sha256':sha(b)}
def writejson(path,value):path.parent.mkdir(parents=True,exist_ok=True);path.write_text(json.dumps(value,indent=2,ensure_ascii=False)+'\n')
(out/'payload').mkdir(parents=True,exist_ok=True);ev=out/'evidence';ev.mkdir(exist_ok=True)
def retain(path,rel):
 dest=ev/rel;dest.parent.mkdir(parents=True,exist_ok=True);shutil.copyfile(path,dest);return record(dest,rel)
base={'name':'@playcanvas/splat-transform','version':'3.10.2','commit':'e0dab1fa0b7f7546d2b4b197f6294570e53ba3b8','package_json_sha256':sha((stage/'originals/package/package.json').read_bytes())}
paths=['lib/webp.mjs','lib/webp.wasm']+[f'dist/{n}{ext}' for n in ['index.mjs','index.cjs','worker.mjs','cli.mjs'] for ext in ['', '.map']]
files=[];derived=[]
for path in paths:
 b=(stage/'sources/splat-transform'/path).read_bytes();baseline=stage/'originals/package'/path
 zipped=gzip.compress(b,compresslevel=9,mtime=0);payload='payload/'+path.replace('/','--')+'.gz';(out/payload).write_bytes(zipped)
 item={'path':path,'payload':payload,'compressed_sha256':sha(zipped),'sha256':sha(b),'size_bytes':len(b),'base_sha256':sha(baseline.read_bytes()) if baseline.exists() else None};files.append(item)
 derived.append({'file':record(stage/'sources/splat-transform'/path),'original_sha256':item['base_sha256']})
original=retain(stage/'originals/source/src/lib/utils/webp-codec.ts','originals/webp-codec.ts')
modified=retain(stage/'sources/splat-transform/src/lib/utils/webp-codec.ts','sources/splat-transform/src/lib/utils/webp-codec.ts')
patch=''.join(difflib.unified_diff((stage/'originals/source/src/lib/utils/webp-codec.ts').read_text().splitlines(True),(stage/'sources/splat-transform/src/lib/utils/webp-codec.ts').read_text().splitlines(True),fromfile='a/src/lib/utils/webp-codec.ts',tofile='b/src/lib/utils/webp-codec.ts'))
(ev/'source-cleanup.patch').write_text(patch);patchref=record(ev/'source-cleanup.patch','source-cleanup.patch')
patchrecord={'original_sha256':original['sha256'],'modified_sha256':modified['sha256'],'patch_sha256':patchref['sha256'],'scope':'Retain the 3.10.2 effort API and level ABI; release all caller allocations and codec outputs in finally for failures and JS exceptions.'};writejson(ev/'source-patch.json',patchrecord)
wrapper=retain(stage/'sources/splat-transform/lib/webp.c','sources/splat-transform/lib/webp.c')
retain(stage/'originals/package/package.json','originals/package.json');retain(stage/'sources/splat-transform/package-lock.json','sources/splat-transform/package-lock.json')
retain(stage/'originals/source/rollup.config.mjs','originals/rollup.config.mjs');retain(stage/'sources/splat-transform/rollup.config.mjs','sources/splat-transform/rollup.config.mjs')
rollupdiff=''.join(difflib.unified_diff((stage/'originals/source/rollup.config.mjs').read_text().splitlines(True),(stage/'sources/splat-transform/rollup.config.mjs').read_text().splitlines(True),fromfile='a/rollup.config.mjs',tofile='b/rollup.config.mjs'))
(ev/'fixed-revision.patch').write_text(rollupdiff)
for script in ['run-step.py','build-distributions.mjs','verify-codec-cleanup.mjs','verify-distributions.mjs','emit-overlay.py','build-environment.json','source-identity.json']:
 retain(stage/script,script)
steps=[]
for name in ['download-npm','npm-ci','link-webp','build-distributions','verify-cleanup-official','verify-distributions','verify-upstream']:
 command=json.loads((stage/'receipts'/f'{name}.json').read_text());assert command['exit_code']==0
 retain(stage/'receipts'/f'{name}.json',f'receipts/{name}.json');retain(stage/command['log']['path'],command['log']['path'])
 steps.append({'path':f'receipts/{name}.json','command':command})
linkmap=retain(stage/'outputs/webp-link.map','outputs/webp-link.map');symbol=retain(stage/'outputs/webp.mjs.symbols','outputs/webp.mjs.symbols')
member=lambda x:re.search(r'(lib(?:c|dlmalloc|compiler_rt|webp|sharpyuv)\.a\([^()]+\))$',x).group(1)
linked=sorted(set(member(m) for m in re.findall(r'[^\s]+\.a\([^()]+\)',(stage/'outputs/webp-link.map').read_text())))
assert set(linked)==set(member(x) for x in old['runtime_evidence']['linked_members'])
runtime=copy.deepcopy(old['runtime_evidence']);runtime['linked_members']=linked
for m in runtime['source_mapping']:m['archive_member']=member(m['archive_member'])
for original_notice in runtime['original_notices_and_linked_sources']:
 retain(oldroot/'evidence'/original_notice['path'],original_notice['path'])
 if original_notice['path']=='licenses/splat-transform/LICENSE':
  retained=retain(stage/'sources/splat-transform/LICENSE',original_notice['path']);original_notice.update(retained);original_notice['origin']='splat-transform e0dab1fa0b7f7546d2b4b197f6294570e53ba3b8';original_notice['reason']='Official 3.10.2 C wrapper and cleanup-patched TypeScript wrapper with derived distributions'
inherited=retain(oldroot/'build-evidence.json','reuse/build-evidence-3.4.2.json')
runtime['scope']='New link map was compared to the inherited reviewed runtime/source mapping; all 94 members match. Inherited codec/distribution acceptance is historical and is not this build\'s acceptance.'
retain(oldroot/'evidence/sources/libwebp/sharpyuv/sharpyuv.h','sources/libwebp/sharpyuv/sharpyuv.h')
sources=copy.deepcopy(old['sources'])
for s in sources:
 if s['name']=='splat-transform':
  s.update(version='3.10.2',commit=base['commit'],download_url='https://codeload.github.com/playcanvas/splat-transform/tar.gz/'+base['commit'],archive=record(stage/'downloads/splat-transform-e0dab1fa.tar.gz'),wrapper=wrapper)
  s['npm']={'download_url':'https://registry.npmjs.org/@playcanvas/splat-transform/-/splat-transform-3.10.2.tgz','archive':record(stage/'downloads/splat-transform-3.10.2.tgz'),'integrity':'sha512-HqPKu4mY63Ec7Cf92UQKopc9LdNyszWka47eepbL30RCg76RIECn4EUX+zyQtMs7NWfjU29e6q3zO4itA8T/eQ=='}
cleanup=json.loads((stage/'logs/verify-cleanup-official.log').read_text());assert cleanup['status']=='passed'
upstream=(stage/'logs/verify-upstream.log').read_text();passed=int(re.search(r'^# pass (\d+)$',upstream,re.M).group(1));failed=int(re.search(r'^# fail (\d+)$',upstream,re.M).group(1));assert failed==0
upstream_summary={'status':'passed','tests':passed+failed,'passed':passed,'failed':failed,'suite_files':['test/webp-codec.test.mjs','test/write-sog.test.mjs','test/html-output.test.mjs'],'log':record(stage/'logs/verify-upstream.log')};writejson(ev/'receipts/upstream-acceptance.json',upstream_summary)
candidate={'kind':'derived-overlay-candidate-3.10.2-v1','base':base,'files':files};writejson(ev/'candidate-manifest.json',candidate)
config={'allocator':'dlmalloc','simd':False,'threads':False,'stage':str(stage),'upstream_C_wrapper_unchanged':True,'codec_source_change':{'original':original,'modified':modified,'patch':patchref,'patch_record':record(ev/'source-patch.json','source-patch.json')},'fixed_revision_patch':record(ev/'fixed-revision.patch','fixed-revision.patch'),'reused_libraries':[{**record(root/p, p)} for p in ['target/macos-m4/webp-rebuild-20261028/build-libwebp/libwebp.a','target/macos-m4/webp-rebuild-20261028/build-libwebp/libsharpyuv.a']],'reused_build_evidence':inherited,'build_driver':record(ev/'build-distributions.mjs','build-distributions.mjs'),'emit_driver':record(ev/'emit-overlay.py','emit-overlay.py')}
evidence={'schema_version':2,'profile':profile,'kind':'fixed-source-webp-rebuild','status':'passed-node-acceptance','completed_at':datetime.datetime.now(datetime.timezone.utc).isoformat(),'sources':sources,'toolchain':old['toolchain'],'configuration':config,'successful_steps':steps,'outputs':{'paired_codec':[record(stage/'outputs'/n) for n in ['webp.mjs','webp.wasm']],'link_map':linkmap,'symbol_map':symbol,'derived_files':derived,'overlay_candidate':record(ev/'candidate-manifest.json','candidate-manifest.json')},'runtime_evidence':runtime,'verification':{'codec':record(ev/'logs/verify-cleanup-official.log','logs/verify-cleanup-official.log'),'cleanup':record(ev/'logs/verify-cleanup-official.log','logs/verify-cleanup-official.log'),'cleanup_counts':cleanup['counts'],'official_binary_comparisons':len(cleanup['official_binary_comparison']),'distributions':record(ev/'logs/verify-distributions.log','logs/verify-distributions.log'),'upstream_sog_html_webp_tests':{**upstream_summary,'receipt':record(ev/'receipts/upstream-acceptance.json','receipts/upstream-acceptance.json')}},'limits':['Fresh Node tests against actual new ABI and bundles; browser/native full application acceptance is separate.','Inherited libwebp/SDK caches have fixed original source/build provenance; no old codec or distribution test is counted as new acceptance.','Allocation fault injection measures caller-visible ownership, not arbitrary true OOM or every libwebp internal allocation.','Direct Node CJS require has the same PlayCanvas interop limitation as the official 3.10.2 package; CJS codec/worker tests use actual PlayCanvas ESM exports as its external.']}
evidence['files']=[record(p,str(p.relative_to(ev))) for p in sorted(ev.rglob('*')) if p.is_file()]
writejson(out/'build-evidence.json',evidence)
manifest={'schema_version':1,'id':profile,'base':base,'build_evidence_sha256':sha((out/'build-evidence.json').read_bytes()),'files':files};writejson(out/'manifest.json',manifest)
def digest(rows):return sha(json.dumps(sorted(rows,key=lambda a:a[0]),separators=(',',':'),ensure_ascii=False).encode())
pins={'profile':profile,'base':base,'source_archive_sha256':sources[2]['archive']['sha256'] if sources[2]['name']=='splat-transform' else next(s for s in sources if s['name']=='splat-transform')['archive']['sha256'],'wrapper_sha256':wrapper['sha256'],'original_codec_sha256':original['sha256'],'modified_codec_sha256':modified['sha256'],'patch_sha256':patchref['sha256'],'license_sha256':sha((stage/'sources/splat-transform/LICENSE').read_bytes()),'files_digest':digest([[r['path'],r['sha256'],r['size_bytes']] for r in evidence['files']]),'runtime_mapping_digest':digest([[m['archive_member'],sorted(m['source_paths'])] for m in runtime['source_mapping']]),'runtime_notices_digest':digest([[n['path'],n['source_path'],n['origin'],n['sha256'],n['size_bytes']] for n in runtime['original_notices_and_linked_sources']]),'evidence_sha256':manifest['build_evidence_sha256'],'counts':{'files':len(evidence['files']),'notices':len(runtime['original_notices_and_linked_sources']),'linked_members':len(linked)}}
writejson(stage/'profile-pins.json',pins);print(json.dumps(pins,indent=2))
