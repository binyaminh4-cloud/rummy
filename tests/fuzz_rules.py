# Independent brute-force checker vs the server function on random hands.
import random, subprocess, sys, functools
def suit(c): return (c%52)//13
def rank(c): return c%13+1
def melds_possible(cards):
    reals=tuple(sorted([c for c in cards if c<104], key=lambda c:(suit(c),rank(c))))
    j=sum(1 for c in cards if c>=104)
    @functools.lru_cache(None)
    def solve(r, j):
        if not r: return j==0
        c=r[0]; s,k=suit(c),rank(c); rest=list(r[1:])
        # every candidate meld containing c: enumerate subsets of rest (small) cheaply by structure
        # sets
        others=[x for x in rest if rank(x)==k and suit(x)!=s]
        bysuit={}
        for x in others: bysuit.setdefault(suit(x),x)
        opts=list(bysuit.values())
        for m in range(1<<len(opts)):
            ch=[opts[i] for i in range(len(opts)) if m>>i&1]
            nr=1+len(ch)
            if nr<2: continue
            for sz in range(max(3,nr),5):
                jn=sz-nr
                if jn<=j:
                    rem=list(rest)
                    for x in ch: rem.remove(x)
                    if solve(tuple(rem), j-jn): return True
        # runs: any window [lo,hi] of values (1..14, ace 1 or 14) containing c's value
        for v in ([1,14] if k==1 else [k]):
            for lo in range(1 if v!=14 else 2, v+1):
                for hi in range(max(v,lo+2), (13 if v==1 else 14)+1):
                    # choose for each position real-or-joker, all combos
                    pos=[p for p in range(lo,hi+1) if p!=v]
                    def rec(i, rem, jj, nreal):
                        if i==len(pos):
                            return nreal>=2 and solve(tuple(rem), jj)
                        p=pos[i]; rk=1 if p==14 else p
                        cand=[x for x in rem if suit(x)==s and rank(x)==rk]
                        if cand:
                            r2=list(rem); r2.remove(cand[0])
                            if rec(i+1, r2, jj, nreal+1): return True
                        if jj>0 and rec(i+1, rem, jj-1, nreal): return True
                        return False
                    if rec(0, rest, j, 1): return True
        return False
    return solve(reals, j)

random.seed(int(sys.argv[1]) if len(sys.argv)>1 else 1)
hands=[]
for _ in range(int(sys.argv[2]) if len(sys.argv)>2 else 3000):
    # build near-win hands: random melds then mutate
    deck=list(range(108)); random.shuffle(deck)
    h=[]
    while len(h)<14:
        t=random.random()
        if t<0.45:
            s=random.randrange(4); lo=random.randint(1,12); L=random.randint(3,5)
            for p in range(lo,min(lo+L,15)):
                rk=1 if p==14 else p; h.append(random.randrange(2)*52+s*13+rk-1)
        elif t<0.9:
            rk=random.randint(1,13); ss=random.sample(range(4),random.randint(3,4))
            for s in ss: h.append(random.randrange(2)*52+s*13+rk-1)
        else:
            h.append(random.randint(104,107))
    h=h[:14]
    for _ in range(random.randint(0,2)):
        h[random.randrange(14)]=random.randrange(108)
    # jokers and duplicates must be legal: at most 2 copies of a card, 4 jokers distinct
    from collections import Counter
    cnt=Counter(h)
    if any(v>2 for x,v in cnt.items() if x<104) : continue
    # map duplicate ids within 0..51 base to physical ids
    phys=[]; seen=Counter(); jk=104; okh=True
    for x in h:
        if x>=104:
            if jk>107: okh=False; break
            phys.append(jk); jk+=1; continue
        b=x%52; seen[b]+=1
        if seen[b]>2: okh=False; break
        phys.append(b if seen[b]==1 else b+52)
    if okh: hands.append(phys)
expected=[melds_possible(h) for h in hands]
sql="\n".join(f"select {i}, rummy_is_win(array{h}::int[]);" for i,h in enumerate(hands))
open("/tmp/fz.sql","w").write(sql)
out=subprocess.run(["psql","-h","/tmp","-p","5433","-U","postgres","-d","t","-At","-F","|","-f","/tmp/fz.sql"],capture_output=True,text=True)
got={int(a):b=="t" for a,b in (l.split("|") for l in out.stdout.split("\n") if l)}
bad=[i for i in range(len(hands)) if got.get(i)!=expected[i]]
print("hands",len(hands),"wins",sum(expected),"mismatches",len(bad), out.stderr[:300])
for i in bad[:5]: print(hands[i], "py", expected[i], "sql", got.get(i))
sys.exit(1 if bad else 0)
