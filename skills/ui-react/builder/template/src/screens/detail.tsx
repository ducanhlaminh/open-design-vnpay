import { useNavigate } from 'react-router-dom'
import { ArrowLeft } from 'lucide-react'
import { Button } from '@/components/ui/button'

export default function Detail() {
  const nav = useNavigate()
  return (
    <div className="mx-auto flex min-h-dvh max-w-md flex-col justify-center gap-6 p-6">
      <div className="rounded-xl border border-border bg-card p-6 text-card-foreground shadow-sm">
        <h1 className="text-xl font-semibold">Chi tiết</h1>
        <p className="mt-1 text-sm text-muted-foreground">Màn hình thứ hai.</p>
        <Button variant="ghost" className="mt-4" onClick={() => nav(-1)}>
          <ArrowLeft /> Quay lại
        </Button>
      </div>
    </div>
  )
}
