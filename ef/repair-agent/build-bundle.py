from pathlib import Path
import hashlib, json, os, shutil, zipfile
src=Path("ef/repair-agent")
out=Path("Council-Local-Repair-Agent")
out.mkdir()
for p in src.rglob("*"):
    if p.is_file() and p.suffix in {".mjs",".cmd",".ps1",".patch"}:
        q=out/p.relative_to(src);q.parent.mkdir(parents=True,exist_ok=True);shutil.copyfile(p,q)
for original,target in [("PUBLIC-REPAIR-BRIEF.md","REPAIR-BRIEF.md"),("PUBLIC-LOCAL-MISSION.md","LOCAL-MISSION.md"),("PUBLIC-README.txt","README.txt")]:
    shutil.copyfile(src/original,out/target)
evidence={
 "status":"LOCAL_ACCEPTANCE_REQUIRED",
 "remote_tests":"PASS: both Windows and Linux acceptance jobs completed successfully before packaging",
 "commit":os.environ["GITHUB_SHA"],
 "workflow_run":"https://github.com/"+os.environ["GITHUB_REPOSITORY"]+"/actions/runs/"+os.environ["GITHUB_RUN_ID"],
 "checks":["gateway authentication and member isolation","member and gateway crash/hang recovery","real sidecar persistence and tool writes with a controlled provider","station backup/restore","Windows DPAPI and exact process ownership","startup task registration and independent Task Scheduler launch","desktop recovery action","official pinned Codex CLI installation/version/help"],
 "local_pc_not_verified":["fresh issuer launch and full UI","installed local-model reply and tool action","original owner data","Bitdefender","65-minute idle/resume","actual sign-in or reboot","installed rollback"]
}
(out/"ACCEPTANCE.json").write_text(json.dumps(evidence,indent=2)+"\n")
files=sorted(p for p in out.rglob("*") if p.is_file())
(out/"SHA256SUMS.txt").write_text("".join(hashlib.sha256(p.read_bytes()).hexdigest()+"  "+p.relative_to(out).as_posix()+"\n" for p in files))
archive=Path("Council-Local-Repair-Agent.zip")
with zipfile.ZipFile(archive,"w",zipfile.ZIP_DEFLATED) as z:
    for p in sorted(out.rglob("*")):
        if p.is_file():z.write(p,p.relative_to(out.parent))
with zipfile.ZipFile(archive) as z:
    assert z.testzip() is None
    for p in out.rglob("*"):
        if p.is_file():assert z.read(str(p.relative_to(out.parent)))==p.read_bytes()
print("Verified bundle:",archive,archive.stat().st_size,"bytes")
