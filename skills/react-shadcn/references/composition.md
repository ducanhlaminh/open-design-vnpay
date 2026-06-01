# Composition patterns

Các pattern tham khảo về **layout intent** (cấu trúc + className theo token) khi
compose UI VNPAY. Skill này render từ `screen.json` (cây node), KHÔNG paste JSX —
nên đọc các snippet JSX dưới đây như bản đồ "cấu trúc lồng + class nào ở đâu", rồi
dịch sang node tree: mỗi thẻ JSX ⇒ 1 node `{ componentSlug, props, children }`
(component PascalCase giữ nguyên tên làm `componentSlug`; thẻ HTML thường ⇒ slug
lowercase; `className`/variant ⇒ vào `props`; text con ⇒ `text`). Xem `SKILL.md`
mục "Cấu trúc screen.json".

---

## 1. Hero — cinematic center (taste-skill preferred)

```jsx
function App() {
  return (
    <main className="min-h-screen flex flex-col">
      <nav className="flex items-center justify-between px-8 py-6 max-w-7xl w-full mx-auto">
        <span className="font-semibold tracking-tight">Logomark</span>
        <div className="flex gap-2">
          <Button variant="ghost" size="sm">Login</Button>
          <Button size="sm">Get started</Button>
        </div>
      </nav>

      <section className="flex-1 flex items-center justify-center px-8 py-32 md:py-48">
        <div className="text-center max-w-6xl space-y-8">
          <Badge variant="outline" className="rounded-full px-4 py-1">
            New · Released today
          </Badge>
          <h1
            className="font-semibold tracking-tight leading-[1.05]"
            style={{ fontSize: 'clamp(3rem, 7vw, 6.5rem)' }}
          >
            Design with motion, ship with code.
          </h1>
          <p className="text-muted-foreground text-lg md:text-xl max-w-2xl mx-auto">
            A toolkit for teams that move fast without breaking taste.
          </p>
          <div className="flex gap-3 justify-center pt-4">
            <Button size="lg">Start free</Button>
            <Button variant="outline" size="lg">Watch demo</Button>
          </div>
        </div>
      </section>
    </main>
  );
}
```

---

## 2. Bento grid (gapless, dense flow)

```jsx
function BentoGrid() {
  return (
    <section className="px-8 py-32 max-w-7xl mx-auto">
      <h2 className="text-4xl md:text-5xl font-semibold mb-12 max-w-2xl">
        Built for taste-driven teams.
      </h2>
      <div className="grid grid-cols-1 md:grid-cols-3 grid-flow-dense gap-4 auto-rows-[200px]">
        <Card className="md:col-span-2 md:row-span-2 p-8 flex flex-col justify-end overflow-hidden group relative">
          <div className="absolute inset-0 bg-gradient-to-br from-primary/20 to-transparent" />
          <div className="relative">
            <h3 className="text-3xl font-semibold mb-2">Motion-first</h3>
            <p className="text-muted-foreground">GSAP ScrollTrigger out of the box.</p>
          </div>
        </Card>
        <Card className="p-6 flex flex-col justify-between">
          <Badge variant="secondary">v2.0</Badge>
          <div>
            <div className="text-4xl font-semibold tabular-nums">142k</div>
            <p className="text-sm text-muted-foreground">monthly designers</p>
          </div>
        </Card>
        <Card className="p-6 flex items-center justify-center">
          <span className="text-7xl">◐</span>
        </Card>
        <Card className="md:col-span-2 p-6">
          <h3 className="font-semibold mb-1">Typography by default</h3>
          <p className="text-sm text-muted-foreground">
            Satoshi, Cabinet Grotesk, Geist — never Inter.
          </p>
        </Card>
      </div>
    </section>
  );
}
```

---

## 3. Form (login / contact)

```jsx
function LoginCard() {
  const [email, setEmail] = useState('');
  const [pw, setPw] = useState('');
  return (
    <Card className="w-full max-w-md">
      <CardHeader>
        <CardTitle>Welcome back</CardTitle>
        <CardDescription>Sign in to continue.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="space-y-2">
          <Label htmlFor="email">Email</Label>
          <Input id="email" type="email" value={email} onChange={(e) => setEmail(e.target.value)} />
        </div>
        <div className="space-y-2">
          <Label htmlFor="pw">Password</Label>
          <Input id="pw" type="password" value={pw} onChange={(e) => setPw(e.target.value)} />
        </div>
      </CardContent>
      <CardFooter className="flex-col gap-2">
        <Button className="w-full">Sign in</Button>
        <Button variant="ghost" className="w-full">Continue with Google</Button>
      </CardFooter>
    </Card>
  );
}
```

---

## 4. Dashboard skeleton

```jsx
function Dashboard() {
  const [tab, setTab] = useState('overview');
  return (
    <div className="min-h-screen bg-background">
      <header className="border-b">
        <div className="flex items-center justify-between px-8 h-16 max-w-7xl mx-auto">
          <div className="flex items-center gap-8">
            <span className="font-semibold">Acme</span>
            <Tabs value={tab} onValueChange={setTab}>
              <TabsList>
                <TabsTrigger value="overview">Overview</TabsTrigger>
                <TabsTrigger value="analytics">Analytics</TabsTrigger>
                <TabsTrigger value="reports">Reports</TabsTrigger>
              </TabsList>
            </Tabs>
          </div>
          <Avatar>
            <AvatarFallback>AN</AvatarFallback>
          </Avatar>
        </div>
      </header>

      <main className="px-8 py-10 max-w-7xl mx-auto space-y-8">
        <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
          {['Revenue', 'Active users', 'Churn', 'NPS'].map((label, i) => (
            <Card key={label} className="p-6">
              <p className="text-sm text-muted-foreground">{label}</p>
              <p className="text-3xl font-semibold tabular-nums mt-2">
                {[42_300, 8_421, '2.1%', 71][i]}
              </p>
            </Card>
          ))}
        </div>
        <Card className="p-6">
          <CardTitle className="text-base mb-4">Weekly progress</CardTitle>
          <Progress value={62} />
        </Card>
      </main>
    </div>
  );
}
```

---

## 5. GSAP ScrollTrigger pinning (khi gpt-taste yêu cầu motion)

Motion/JS tùy biến nằm ngoài phạm vi cây JSON tĩnh: nếu cần, thêm GSAP CDN vào
`<head>` của `shell.html` và mở rộng render block (`builder/app-shell-block.jsx`)
— không biểu diễn được bằng `screen.json` thuần.

```jsx
function PinnedSection() {
  const ref = useRef(null);
  useEffect(() => {
    if (!window.gsap || !window.ScrollTrigger) return;
    gsap.registerPlugin(ScrollTrigger);
    const ctx = gsap.context(() => {
      gsap.to('.pinned-title', {
        scrollTrigger: { trigger: ref.current, start: 'top top', end: '+=2000', pin: true, scrub: 1 },
        scale: 0.6,
        opacity: 0.4,
      });
    }, ref);
    return () => ctx.revert();
  }, []);
  return (
    <section ref={ref} className="min-h-screen relative">
      <h2 className="pinned-title text-6xl md:text-8xl font-semibold sticky top-0 px-8 py-16">
        Scroll to reveal.
      </h2>
      {/* content underneath */}
    </section>
  );
}
```

---

## 6. Compose tất cả

```jsx
function App() {
  return (
    <>
      <Hero />
      <BentoGrid />
      <PinnedSection />
      <Footer />
    </>
  );
}
```

---

## Nguyên tắc đặt tên class (theo gpt-tasteskill)

- `max-w-5xl` / `max-w-6xl` / `w-full` cho hero text containers (chống 6-line wrap).
- `font-size: clamp(3rem, 5vw, 5.5rem)` cho hero H1.
- `py-32 md:py-48` giữa các section chính.
- `grid-flow-dense` cho mọi bento grid.
- `group-hover:scale-105 transition-transform duration-700 ease-out` cho card hover.
- Tránh font Inter — ưu tiên Satoshi/Cabinet Grotesk/Outfit/Geist
  (load qua `<link>` Google Fonts trong `<head>` nếu cần).
