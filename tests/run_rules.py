import json, subprocess, sys
S="RBOK"
def ids(hand):
    used=set(); out=[]; jk=104
    for t in hand.split():
        if t=="JK": out.append(jk); jk+=1; continue
        r=int(t[:-1]); s=S.index(t[-1])
        base=s*13+r-1
        cid=base if base not in used else base+52
        used.add(cid); out.append(cid)
    return out
cases=json.load(open(sys.argv[1]))
q=";\n".join(f"select {i}, rummy_is_win(array{ids(c['hand'])}::int[])" for i,c in enumerate(cases))
res=subprocess.run(["psql","-h","/tmp","-p","5433","-U","postgres","-d","t","-At","-F","|","-c",q],capture_output=True,text=True)
bad=0
lines=[l for l in res.stdout.split("\n") if l]
for l in lines:
    i,v=l.split("|"); c=cases[int(i)]; got=(v=="t")
    ok=got==c["win"]; bad+= not ok
    print(("OK  " if ok else "FAIL"), c["why"], "expected", c["win"], "got", got)
print(res.stderr[:500]); print("failures:",bad, "of", len(cases)); sys.exit(1 if bad or len(lines)!=len(cases) else 0)
