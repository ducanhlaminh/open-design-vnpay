# Component inventory — VNPAY UI set (verbatim)

> These are the REAL components, bundled verbatim from
> `vpn-design-main/ui/preview/preview-runtime-v3/src/components/ui` (Base UI +
> radix-ui, Tailwind v4 tokens). You do NOT copy their source — they are already
> compiled into the prebuilt bundle inside `assets/shell.html` and exposed on
> the global `UI` object. The JSON-driven renderer mounts them by `componentSlug`
> (the PascalCase export name, e.g. `"Button"`, `"InputGroupInput"`). The
> destructure form below is how the prebuilt bundle exposes them internally —
> in `screen.json` you reference the export name as a slug, you do not import.

## How to access (no imports)

```jsx
// Everything lives on globals set by the prebuilt bundle:
const { Button, Card, CardHeader, CardTitle, CardContent, Dialog, DialogTrigger } = UI;
// Icons: the full lucide-react set is on `Lucide`
const { ArrowRight, Check, Search } = Lucide;
// Class merge helper (clsx + tailwind-merge), same `cn` the components use:
cn("px-2", condition && "bg-muted");
```

`window.React`, `window.createRoot`, `window.UI`, `window.Lucide`, `window.cn`
are all available before your `<script type="text/babel">` runs. **Do not
`import`/`export`** — Babel Standalone has no module system.

## Full export list (destructure from `UI`)

**Layout / surface**: `Card CardHeader CardTitle CardDescription CardContent CardFooter CardAction` · `AspectRatio` · `Separator` · `ScrollArea ScrollBar` · `Skeleton` · `Table TableHeader TableBody TableFooter TableHead TableRow TableCell TableCaption`

**Actions / inputs**: `Button` · `Input` · `Textarea` · `Label` · `Checkbox` · `Switch` · `Slider` · `RadioGroup RadioGroupItem` · `Toggle` · `ToggleGroup ToggleGroupItem` · `InputOTP InputOTPGroup InputOTPSlot InputOTPSeparator` · `InputGroup InputGroupAddon InputGroupButton InputGroupInput InputGroupText InputGroupTextarea`

**Selection / menus**: `Select SelectTrigger SelectValue SelectContent SelectGroup SelectLabel SelectItem SelectSeparator SelectScrollUpButton SelectScrollDownButton` · `DropdownMenu DropdownMenuTrigger DropdownMenuContent DropdownMenuItem DropdownMenuCheckboxItem DropdownMenuRadioGroup DropdownMenuRadioItem DropdownMenuLabel DropdownMenuSeparator DropdownMenuShortcut DropdownMenuGroup DropdownMenuPortal DropdownMenuSub DropdownMenuSubTrigger DropdownMenuSubContent` · `Command CommandDialog CommandInput CommandList CommandEmpty CommandGroup CommandItem CommandShortcut CommandSeparator`

**Overlays**: `Dialog DialogTrigger DialogContent DialogHeader DialogFooter DialogTitle DialogDescription DialogClose DialogOverlay DialogPortal` · `AlertDialog AlertDialogTrigger AlertDialogContent AlertDialogHeader AlertDialogFooter AlertDialogTitle AlertDialogDescription AlertDialogAction AlertDialogCancel AlertDialogMedia AlertDialogOverlay AlertDialogPortal` · `Sheet SheetTrigger SheetContent SheetHeader SheetFooter SheetTitle SheetDescription SheetClose` · `Drawer DrawerTrigger DrawerContent DrawerHeader DrawerFooter DrawerTitle DrawerDescription DrawerClose DrawerOverlay DrawerPortal` · `Popover PopoverTrigger PopoverContent PopoverHeader PopoverTitle PopoverDescription` · `HoverCard HoverCardTrigger HoverCardContent` · `Tooltip TooltipProvider TooltipTrigger TooltipContent`

**Disclosure / nav**: `Accordion AccordionItem AccordionTrigger AccordionContent` · `Collapsible CollapsibleTrigger CollapsibleContent` · `Tabs TabsList TabsTrigger TabsContent` · `Breadcrumb BreadcrumbList BreadcrumbItem BreadcrumbLink BreadcrumbPage BreadcrumbSeparator BreadcrumbEllipsis` · `Pagination PaginationContent PaginationItem PaginationLink PaginationPrevious PaginationNext PaginationEllipsis`

**Feedback / status**: `Alert AlertTitle AlertDescription AlertAction` · `Badge` · `Progress ProgressTrack ProgressIndicator ProgressValue ProgressLabel`

**Data display**: `Avatar AvatarImage AvatarFallback AvatarBadge AvatarGroup AvatarGroupCount`

**Forms (react-hook-form)**: `Form FormField FormItem FormLabel FormControl FormDescription FormMessage` · `Field FieldSet FieldLegend FieldGroup FieldLabel FieldTitle FieldDescription FieldError FieldContent FieldSeparator`

**Media / motion**: `Carousel CarouselContent CarouselItem CarouselPrevious CarouselNext`

## Key variants (props)

| Component | `variant` | `size` |
|---|---|---|
| `Button` | `default` `outline` `secondary` `ghost` `destructive` `link` | `default` `xs` `sm` `lg` `icon` `icon-xs` `icon-sm` `icon-lg` |
| `Badge` | `default` `secondary` `destructive` `outline` `ghost` | — |
| `Alert` | `default` `destructive` | — |
| `Toggle` / `ToggleGroup` | `default` `outline` | `default` `sm` `lg` |

Defaults: `variant="default"`, `size="default"`. Pass them as normal props,
e.g. `<Button variant="outline" size="sm">`.

## Theme tokens (already wired)

The bundle ships the full VNPAY token layer (`app.css` + `shadcn-tailwind.css`)
with a built-in default dark theme. Use the semantic Tailwind utilities the
components use — they resolve against the tokens:

`bg-background` `text-foreground` `bg-card` `text-card-foreground`
`bg-primary` `text-primary-foreground` `bg-secondary` `bg-muted`
`text-muted-foreground` `bg-accent` `bg-destructive` `border-border`
`ring-ring` · radius via `rounded-lg/md/sm` · card variants `bg-card-elevated`
`bg-card-emphasis`.

Prefer these semantic tokens over hard-coded colors so output stays on-brand
and theme-swappable. Arbitrary Tailwind values (`bg-[#1fb6d4]`, `grid-cols-[1fr_2fr]`)
also work — the in-browser Tailwind v4 engine JIT-compiles whatever appears in
the DOM.

### Brand thật từ KG (VNPAY Glass) — pull đủ 7 layer

Default theme trong bundle chỉ là tông sẵn để preview. Muốn artifact mang **design
system thật trong KG**, KHÔNG tự chế giá trị: pull qua `sm-mcp` rồi bind verbatim vào
`:root`/`html.dark`. **Phải lấy CẢ 7 layer** của composition (spacing · radius ·
typography · control-density · color · icon · brand), không chỉ layer màu — nếu thiếu,
radius/font/chiều-cao-control sẽ sai so với KG. Lưu ý 2 điểm bộ component này KHÔNG tự
xử được, phải bind thêm:

- **Control sizing**: component hardcode `h-8`… và KHÔNG đọc token control của KG
  (chỉ `Switch` đọc `--switch-*`). Áp "Large controls" (48px…) phải map qua `[data-slot]`.
- **Glass surface**: `card`/popover-family cần backdrop-blur + inset shadow + viền
  hairline `::before`, không phải màu phẳng.

Bảng mapping đầy đủ + cypher + dual-scheme: `references/kg-brand-binding.md`. Stylesheet
sẵn dùng: `assets/vnpay-glass.css`. Verify mắt: `assets/showcase.html`.

## Icons

The entire `lucide-react` set is on `Lucide`. Usage:
`<Lucide.ArrowRight className="size-4" />`. Components already render their own
internal icons; you only reach for `Lucide` for your own content.
