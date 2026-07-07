import { useNavigate } from 'react-router-dom'
import { ArrowRight } from 'lucide-react'
import { Button } from '@/components/ui/button'

// Sample screen — the ui-react pipeline replaces these with the real screens
// authored from the UX Spec. Screens DEFAULT-export their component so the build
// can generate a per-screen entry for the canvas.
export default function Home() {
  const nav = useNavigate()
  return (
    <div className="mx-auto flex min-h-dvh max-w-md flex-col justify-center gap-6 p-6">
      <div className="rounded-xl border border-border bg-card p-6 text-card-foreground shadow-sm">
        <h1 className="text-xl font-semibold">VNPAY React App</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Sinh từ pipeline docs → React. Đây là màn hình mẫu.
        </p>
        <div className="mt-4 flex gap-2">
          <Button onClick={() => nav('/detail')}>
            Tiếp tục <ArrowRight />
          </Button>
          <Button variant="outline">Huỷ</Button>
        </div>
      </div>
    </div>
  )
}
