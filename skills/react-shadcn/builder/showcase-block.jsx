/* ===================================================================== *
 *  COMPONENT SHOWCASE — VNPAY Merchant brand (Payment Glass Pro base).
 *
 *  Babel-standalone transpiles this block at runtime. The prebuilt bundle
 *  above already exposed window.{React, createRoot, UI, Lucide, cn}. We
 *  consume the verbatim components/ui/* set and render every component with
 *  the brand tokens bound in the <style> override (light :root + html.dark).
 *
 *  Tokens are pulled VERBATIM from the sm-mcp Knowledge Graph
 *  (composition "VNPAY Glass" → Payment Glass Pro color + VNPAY Merchant brand).
 * ===================================================================== */
const { useState } = React;
const I = Lucide;

const {
  Button, Badge,
  Card, CardHeader, CardTitle, CardDescription, CardContent, CardFooter, CardAction,
  Alert, AlertTitle, AlertDescription, AlertAction,
  Avatar, AvatarImage, AvatarFallback, AvatarGroup, AvatarGroupCount, AvatarBadge,
  Accordion, AccordionItem, AccordionTrigger, AccordionContent,
  Tabs, TabsList, TabsTrigger, TabsContent,
  Collapsible, CollapsibleTrigger, CollapsibleContent,
  Switch, Checkbox, RadioGroup, RadioGroupItem, Slider, Progress,
  Input, Textarea, Label,
  InputGroup, InputGroupAddon, InputGroupInput, InputGroupText, InputGroupButton,
  InputOTP, InputOTPGroup, InputOTPSlot, InputOTPSeparator,
  Select, SelectTrigger, SelectValue, SelectContent, SelectItem, SelectGroup, SelectLabel, SelectSeparator,
  Dialog, DialogTrigger, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter, DialogClose,
  AlertDialog, AlertDialogTrigger, AlertDialogContent, AlertDialogHeader, AlertDialogTitle,
  AlertDialogDescription, AlertDialogFooter, AlertDialogAction, AlertDialogCancel,
  Sheet, SheetTrigger, SheetContent, SheetHeader, SheetTitle, SheetDescription, SheetFooter, SheetClose,
  Drawer, DrawerTrigger, DrawerContent, DrawerHeader, DrawerTitle, DrawerDescription, DrawerFooter, DrawerClose,
  Popover, PopoverTrigger, PopoverContent, PopoverHeader, PopoverTitle, PopoverDescription,
  HoverCard, HoverCardTrigger, HoverCardContent,
  Tooltip, TooltipProvider, TooltipTrigger, TooltipContent,
  DropdownMenu, DropdownMenuTrigger, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel,
  DropdownMenuSeparator, DropdownMenuGroup, DropdownMenuCheckboxItem, DropdownMenuShortcut,
  Command, CommandInput, CommandList, CommandEmpty, CommandGroup, CommandItem, CommandSeparator, CommandShortcut,
  Table, TableHeader, TableBody, TableRow, TableHead, TableCell, TableCaption, TableFooter,
  Pagination, PaginationContent, PaginationItem, PaginationLink, PaginationPrevious, PaginationNext, PaginationEllipsis,
  Breadcrumb, BreadcrumbList, BreadcrumbItem, BreadcrumbLink, BreadcrumbPage, BreadcrumbSeparator,
  Separator, Skeleton, AspectRatio, ScrollArea,
  Toggle, ToggleGroup, ToggleGroupItem,
  Carousel, CarouselContent, CarouselItem, CarouselPrevious, CarouselNext,
  Field, FieldLabel, FieldDescription, FieldError, FieldGroup,
} = UI;

/* A titled section card in the gallery grid. */
function Section({ title, span, children }) {
  return (
    <section
      data-slot="card"
      className={cn(
        "flex flex-col gap-4 rounded-[var(--radius-card,28px)] bg-card text-card-foreground p-5",
        span === 2 && "md:col-span-2",
        span === 3 && "md:col-span-2 xl:col-span-3",
      )}
    >
      <h2 className="type-label-xs font-semibold tracking-[0.12em] text-muted-foreground uppercase">{title}</h2>
      <div className="flex flex-col gap-4">{children}</div>
    </section>
  );
}

const Row = ({ children }) => <div className="flex flex-wrap items-center gap-3">{children}</div>;

function ButtonsDemo() {
  return (
    <Section title="Button">
      <Row>
        <Button>Default</Button>
        <Button variant="secondary">Secondary</Button>
        <Button variant="outline">Outline</Button>
        <Button variant="ghost">Ghost</Button>
        <Button variant="destructive">Destructive</Button>
        <Button variant="link">Link</Button>
      </Row>
      <Row>
        <Button size="sm">Small</Button>
        <Button>Default</Button>
        <Button size="lg">Large</Button>
        <Button size="icon" aria-label="add"><I.Plus /></Button>
        <Button disabled><I.Loader className="animate-spin" /> Loading</Button>
        <Button><I.QrCode /> Quét QR</Button>
      </Row>
    </Section>
  );
}

function BadgesDemo() {
  return (
    <Section title="Badge">
      <Row>
        <Badge>Default</Badge>
        <Badge variant="secondary">Secondary</Badge>
        <Badge variant="outline">Outline</Badge>
        <Badge variant="destructive">Destructive</Badge>
        <Badge><I.Check className="size-3" /> Đã xác thực</Badge>
      </Row>
    </Section>
  );
}

function CardDemo() {
  return (
    <Section title="Card">
      <Card>
        <CardHeader>
          <CardTitle>Số dư khả dụng</CardTitle>
          <CardDescription>Ví VNPAY Merchant</CardDescription>
          <CardAction>
            <Button size="icon-sm" variant="ghost"><I.MoreHorizontal /></Button>
          </CardAction>
        </CardHeader>
        <CardContent>
          <div className="type-display-small font-display">₫ 12.480.000</div>
          <p className="mt-1 text-sm text-muted-foreground">+2,4% so với tháng trước</p>
        </CardContent>
        <CardFooter className="gap-2">
          <Button className="flex-1"><I.ArrowUpRight /> Chuyển</Button>
          <Button variant="outline" className="flex-1"><I.ArrowDownLeft /> Nạp</Button>
        </CardFooter>
      </Card>
    </Section>
  );
}

function AlertDemo() {
  return (
    <Section title="Alert">
      <Alert>
        <I.Info />
        <AlertTitle>Cập nhật hệ thống</AlertTitle>
        <AlertDescription>Bảo trì lúc 02:00 sáng mai, dịch vụ có thể gián đoạn.</AlertDescription>
      </Alert>
      <Alert variant="destructive">
        <I.TriangleAlert />
        <AlertTitle>Giao dịch thất bại</AlertTitle>
        <AlertDescription>Số dư không đủ để hoàn tất thanh toán.</AlertDescription>
      </Alert>
    </Section>
  );
}

function AvatarDemo() {
  return (
    <Section title="Avatar">
      <Row>
        <Avatar>
          <AvatarImage src="https://i.pravatar.cc/80?img=12" alt="user" />
          <AvatarFallback>VP</AvatarFallback>
        </Avatar>
        <Avatar><AvatarFallback>AN</AvatarFallback></Avatar>
        <AvatarGroup>
          <Avatar><AvatarFallback>A</AvatarFallback></Avatar>
          <Avatar><AvatarFallback>B</AvatarFallback></Avatar>
          <Avatar><AvatarFallback>C</AvatarFallback></Avatar>
          <AvatarGroupCount>+5</AvatarGroupCount>
        </AvatarGroup>
      </Row>
    </Section>
  );
}

function AccordionDemo() {
  return (
    <Section title="Accordion">
      <Accordion type="single" collapsible defaultValue="a1" className="w-full">
        <AccordionItem value="a1">
          <AccordionTrigger>Phí giao dịch là bao nhiêu?</AccordionTrigger>
          <AccordionContent>Miễn phí cho giao dịch nội bộ VNPAY; liên ngân hàng theo biểu phí.</AccordionContent>
        </AccordionItem>
        <AccordionItem value="a2">
          <AccordionTrigger>Thời gian đối soát?</AccordionTrigger>
          <AccordionContent>Đối soát tự động vào cuối ngày (T+0), báo cáo sẵn sàng sáng T+1.</AccordionContent>
        </AccordionItem>
      </Accordion>
    </Section>
  );
}

function TabsDemo() {
  return (
    <Section title="Tabs">
      <Tabs defaultValue="overview" className="w-full">
        <TabsList>
          <TabsTrigger value="overview">Tổng quan</TabsTrigger>
          <TabsTrigger value="tx">Giao dịch</TabsTrigger>
          <TabsTrigger value="settle">Đối soát</TabsTrigger>
        </TabsList>
        <TabsContent value="overview" className="text-sm text-muted-foreground">Doanh thu hôm nay: ₫ 4.120.000 qua 87 giao dịch.</TabsContent>
        <TabsContent value="tx" className="text-sm text-muted-foreground">87 giao dịch thành công, 2 chờ xử lý.</TabsContent>
        <TabsContent value="settle" className="text-sm text-muted-foreground">Kỳ đối soát gần nhất: 31/05, đã khớp.</TabsContent>
      </Tabs>
    </Section>
  );
}

function CollapsibleDemo() {
  const [open, setOpen] = useState(false);
  return (
    <Section title="Collapsible">
      <Collapsible open={open} onOpenChange={setOpen} className="flex flex-col gap-2">
        <CollapsibleTrigger render={<Button variant="outline" className="justify-between" />}>
          Chi tiết đơn hàng <I.ChevronDown className={cn("transition-transform", open && "rotate-180")} />
        </CollapsibleTrigger>
        <CollapsibleContent className="flex flex-col gap-2 text-sm text-muted-foreground">
          <div className="rounded-md border border-border p-3">Mã đơn: #VNP-10293</div>
          <div className="rounded-md border border-border p-3">Phương thức: QR động</div>
        </CollapsibleContent>
      </Collapsible>
    </Section>
  );
}

function TogglesDemo() {
  const [checked, setChecked] = useState(true);
  return (
    <Section title="Switch · Checkbox · Radio · Toggle">
      <Row>
        <Label className="flex items-center gap-2"><Switch checked={checked} onCheckedChange={setChecked} /> Thông báo đẩy</Label>
      </Row>
      <Row>
        <Label className="flex items-center gap-2"><Checkbox defaultChecked /> Lưu thiết bị</Label>
        <Label className="flex items-center gap-2"><Checkbox /> Nhận email</Label>
      </Row>
      <RadioGroup defaultValue="qr" className="flex gap-4">
        <Label className="flex items-center gap-2"><RadioGroupItem value="qr" /> QR</Label>
        <Label className="flex items-center gap-2"><RadioGroupItem value="card" /> Thẻ</Label>
        <Label className="flex items-center gap-2"><RadioGroupItem value="wallet" /> Ví</Label>
      </RadioGroup>
      <Row>
        <Toggle aria-label="bold"><I.Bold /></Toggle>
        <ToggleGroup type="single" defaultValue="left">
          <ToggleGroupItem value="left" aria-label="left"><I.AlignLeft /></ToggleGroupItem>
          <ToggleGroupItem value="center" aria-label="center"><I.AlignCenter /></ToggleGroupItem>
          <ToggleGroupItem value="right" aria-label="right"><I.AlignRight /></ToggleGroupItem>
        </ToggleGroup>
      </Row>
    </Section>
  );
}

function SliderProgressDemo() {
  const [val, setVal] = useState([40]);
  return (
    <Section title="Slider · Progress">
      <div className="flex flex-col gap-2">
        <Label>Hạn mức ngày: ₫ {(val[0] * 100000).toLocaleString("vi-VN")}</Label>
        <Slider value={val} onValueChange={setVal} max={100} step={1} />
      </div>
      <div className="flex flex-col gap-2">
        <Label>Tiến độ KYC</Label>
        <Progress value={val[0]} />
      </div>
    </Section>
  );
}

function InputsDemo() {
  return (
    <Section title="Input · Textarea · InputGroup">
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="sc-email">Email</Label>
        <Input id="sc-email" type="email" placeholder="ten@cua-hang.vn" />
      </div>
      <InputGroup>
        <InputGroupAddon><I.Search /></InputGroupAddon>
        <InputGroupInput placeholder="Tìm giao dịch…" />
        <InputGroupButton>Lọc</InputGroupButton>
      </InputGroup>
      <InputGroup>
        <InputGroupText>₫</InputGroupText>
        <InputGroupInput placeholder="0" inputMode="numeric" />
        <InputGroupText>VND</InputGroupText>
      </InputGroup>
      <Textarea placeholder="Ghi chú cho giao dịch…" />
    </Section>
  );
}

function OtpDemo() {
  return (
    <Section title="Input OTP">
      <InputOTP maxLength={6}>
        <InputOTPGroup>
          <InputOTPSlot index={0} />
          <InputOTPSlot index={1} />
          <InputOTPSlot index={2} />
        </InputOTPGroup>
        <InputOTPSeparator />
        <InputOTPGroup>
          <InputOTPSlot index={3} />
          <InputOTPSlot index={4} />
          <InputOTPSlot index={5} />
        </InputOTPGroup>
      </InputOTP>
    </Section>
  );
}

function SelectDemo() {
  return (
    <Section title="Select">
      <Select defaultValue="vcb">
        <SelectTrigger className="w-full"><SelectValue placeholder="Chọn ngân hàng" /></SelectTrigger>
        <SelectContent>
          <SelectGroup>
            <SelectLabel>Phổ biến</SelectLabel>
            <SelectItem value="vcb">Vietcombank</SelectItem>
            <SelectItem value="tcb">Techcombank</SelectItem>
            <SelectItem value="mb">MB Bank</SelectItem>
          </SelectGroup>
          <SelectSeparator />
          <SelectItem value="acb">ACB</SelectItem>
          <SelectItem value="vpb">VPBank</SelectItem>
        </SelectContent>
      </Select>
    </Section>
  );
}

function FieldDemo() {
  return (
    <Section title="Field / Form">
      <FieldGroup>
        <Field>
          <FieldLabel htmlFor="sc-mid">Mã merchant</FieldLabel>
          <Input id="sc-mid" defaultValue="VNPAYQR0099" />
          <FieldDescription>Mã định danh điểm bán của bạn.</FieldDescription>
        </Field>
        <Field data-invalid="true">
          <FieldLabel htmlFor="sc-amt">Số tiền</FieldLabel>
          <Input id="sc-amt" aria-invalid defaultValue="-50000" />
          <FieldError>Số tiền phải lớn hơn 0.</FieldError>
        </Field>
      </FieldGroup>
    </Section>
  );
}

function OverlaysDemo() {
  return (
    <Section title="Dialog · AlertDialog · Sheet · Drawer">
      <Row>
        <Dialog>
          <DialogTrigger render={<Button variant="outline" />}>Mở Dialog</DialogTrigger>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>Xác nhận chuyển tiền</DialogTitle>
              <DialogDescription>Chuyển ₫ 500.000 đến Nguyễn Văn A (VCB).</DialogDescription>
            </DialogHeader>
            <DialogFooter>
              <DialogClose render={<Button variant="outline" />}>Huỷ</DialogClose>
              <DialogClose render={<Button />}>Xác nhận</DialogClose>
            </DialogFooter>
          </DialogContent>
        </Dialog>

        <AlertDialog>
          <AlertDialogTrigger render={<Button variant="destructive" />}>Xoá</AlertDialogTrigger>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>Xoá liên kết ngân hàng?</AlertDialogTitle>
              <AlertDialogDescription>Hành động này không thể hoàn tác.</AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>Huỷ</AlertDialogCancel>
              <AlertDialogAction>Xoá</AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>

        <Sheet>
          <SheetTrigger render={<Button variant="outline" />}>Mở Sheet</SheetTrigger>
          <SheetContent>
            <SheetHeader>
              <SheetTitle>Bộ lọc giao dịch</SheetTitle>
              <SheetDescription>Tinh chỉnh danh sách hiển thị.</SheetDescription>
            </SheetHeader>
            <div className="p-4 text-sm text-muted-foreground">Nội dung bộ lọc…</div>
            <SheetFooter>
              <SheetClose render={<Button />}>Áp dụng</SheetClose>
            </SheetFooter>
          </SheetContent>
        </Sheet>

        <Drawer>
          <DrawerTrigger render={<Button variant="outline" />}>Mở Drawer</DrawerTrigger>
          <DrawerContent>
            <DrawerHeader>
              <DrawerTitle>Chi tiết hoá đơn</DrawerTitle>
              <DrawerDescription>#VNP-10293 · 31/05/2026</DrawerDescription>
            </DrawerHeader>
            <div className="p-4 text-sm text-muted-foreground">Tổng: ₫ 320.000</div>
            <DrawerFooter>
              <DrawerClose render={<Button />}>Đóng</DrawerClose>
            </DrawerFooter>
          </DrawerContent>
        </Drawer>
      </Row>
    </Section>
  );
}

function PopoversDemo() {
  return (
    <Section title="Popover · HoverCard · Tooltip · Dropdown">
      <Row>
        <Popover>
          <PopoverTrigger render={<Button variant="outline" />}>Popover</PopoverTrigger>
          <PopoverContent>
            <PopoverHeader>
              <PopoverTitle>Mã QR điểm bán</PopoverTitle>
              <PopoverDescription>Khách quét để thanh toán.</PopoverDescription>
            </PopoverHeader>
            <div className="mt-2 grid size-28 place-items-center rounded-md bg-muted"><I.QrCode className="size-16" /></div>
          </PopoverContent>
        </Popover>

        <HoverCard>
          <HoverCardTrigger render={<Button variant="link" />}>@vnpay_merchant</HoverCardTrigger>
          <HoverCardContent>
            <div className="flex gap-3">
              <Avatar><AvatarFallback>VP</AvatarFallback></Avatar>
              <div className="text-sm"><p className="font-semibold">VNPAY Merchant</p><p className="text-muted-foreground">Cổng thanh toán cho điểm bán.</p></div>
            </div>
          </HoverCardContent>
        </HoverCard>

        <Tooltip>
          <TooltipTrigger render={<Button variant="outline" size="icon" aria-label="info" />}><I.Info /></TooltipTrigger>
          <TooltipContent>Phí áp dụng theo biểu phí hiện hành</TooltipContent>
        </Tooltip>

        <DropdownMenu>
          <DropdownMenuTrigger render={<Button variant="outline" />}>Menu <I.ChevronDown /></DropdownMenuTrigger>
          <DropdownMenuContent>
            <DropdownMenuLabel>Tài khoản</DropdownMenuLabel>
            <DropdownMenuSeparator />
            <DropdownMenuGroup>
              <DropdownMenuItem><I.User /> Hồ sơ <DropdownMenuShortcut>⌘P</DropdownMenuShortcut></DropdownMenuItem>
              <DropdownMenuItem><I.Settings /> Cài đặt</DropdownMenuItem>
              <DropdownMenuCheckboxItem checked>Thông báo</DropdownMenuCheckboxItem>
            </DropdownMenuGroup>
            <DropdownMenuSeparator />
            <DropdownMenuItem variant="destructive"><I.LogOut /> Đăng xuất</DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </Row>
    </Section>
  );
}

function CommandDemo() {
  return (
    <Section title="Command">
      <Command className="rounded-lg border border-border shadow-md">
        <CommandInput placeholder="Nhập lệnh hoặc tìm kiếm…" />
        <CommandList>
          <CommandEmpty>Không có kết quả.</CommandEmpty>
          <CommandGroup heading="Gợi ý">
            <CommandItem><I.QrCode /> Tạo mã QR <CommandShortcut>⌘Q</CommandShortcut></CommandItem>
            <CommandItem><I.Send /> Chuyển tiền</CommandItem>
            <CommandItem><I.Calendar /> Xem đối soát</CommandItem>
          </CommandGroup>
          <CommandSeparator />
          <CommandGroup heading="Cài đặt">
            <CommandItem><I.Settings /> Cấu hình điểm bán</CommandItem>
          </CommandGroup>
        </CommandList>
      </Command>
    </Section>
  );
}

function TableDemo() {
  const rows = [
    ["#VNP-10293", "QR động", "₫ 320.000", "Thành công"],
    ["#VNP-10292", "Thẻ ATM", "₫ 1.200.000", "Thành công"],
    ["#VNP-10291", "Ví VNPAY", "₫ 85.000", "Chờ xử lý"],
  ];
  return (
    <Section title="Table" span={2}>
      <Table>
        <TableCaption>Giao dịch gần đây</TableCaption>
        <TableHeader>
          <TableRow>
            <TableHead>Mã</TableHead>
            <TableHead>Phương thức</TableHead>
            <TableHead className="text-right">Số tiền</TableHead>
            <TableHead>Trạng thái</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((r) => (
            <TableRow key={r[0]}>
              <TableCell className="font-medium">{r[0]}</TableCell>
              <TableCell>{r[1]}</TableCell>
              <TableCell className="text-right">{r[2]}</TableCell>
              <TableCell>
                <Badge variant={r[3] === "Thành công" ? "secondary" : "outline"}>{r[3]}</Badge>
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
        <TableFooter>
          <TableRow>
            <TableCell colSpan={2}>Tổng</TableCell>
            <TableCell className="text-right">₫ 1.605.000</TableCell>
            <TableCell />
          </TableRow>
        </TableFooter>
      </Table>
    </Section>
  );
}

function NavDemo() {
  return (
    <Section title="Breadcrumb · Pagination">
      <Breadcrumb>
        <BreadcrumbList>
          <BreadcrumbItem><BreadcrumbLink href="#">Trang chủ</BreadcrumbLink></BreadcrumbItem>
          <BreadcrumbSeparator />
          <BreadcrumbItem><BreadcrumbLink href="#">Giao dịch</BreadcrumbLink></BreadcrumbItem>
          <BreadcrumbSeparator />
          <BreadcrumbItem><BreadcrumbPage>Chi tiết</BreadcrumbPage></BreadcrumbItem>
        </BreadcrumbList>
      </Breadcrumb>
      <Pagination>
        <PaginationContent>
          <PaginationItem><PaginationPrevious href="#" /></PaginationItem>
          <PaginationItem><PaginationLink href="#">1</PaginationLink></PaginationItem>
          <PaginationItem><PaginationLink href="#" isActive>2</PaginationLink></PaginationItem>
          <PaginationItem><PaginationLink href="#">3</PaginationLink></PaginationItem>
          <PaginationItem><PaginationEllipsis /></PaginationItem>
          <PaginationItem><PaginationNext href="#" /></PaginationItem>
        </PaginationContent>
      </Pagination>
    </Section>
  );
}

function MiscDemo() {
  return (
    <Section title="Separator · Skeleton · AspectRatio · ScrollArea">
      <div className="flex items-center gap-3 text-sm">
        <span>Doanh thu</span>
        <Separator orientation="vertical" className="h-4" />
        <span>Chi phí</span>
        <Separator orientation="vertical" className="h-4" />
        <span>Lợi nhuận</span>
      </div>
      <Separator />
      <div className="flex items-center gap-3">
        <Skeleton className="size-10 rounded-full" />
        <div className="flex flex-col gap-2">
          <Skeleton className="h-3 w-32" />
          <Skeleton className="h-3 w-20" />
        </div>
      </div>
      <AspectRatio ratio={16 / 9} className="overflow-hidden rounded-lg bg-muted">
        <div className="grid size-full place-items-center text-muted-foreground"><I.Image className="size-8" /></div>
      </AspectRatio>
      <ScrollArea className="h-28 w-full rounded-md border border-border p-3">
        <div className="flex flex-col gap-2 text-sm">
          {Array.from({ length: 12 }).map((_, i) => (
            <div key={i} className="flex justify-between"><span>Giao dịch {i + 1}</span><span className="text-muted-foreground">₫ {(i + 1) * 50}.000</span></div>
          ))}
        </div>
      </ScrollArea>
    </Section>
  );
}

function CarouselDemo() {
  return (
    <Section title="Carousel">
      <Carousel className="w-full max-w-[260px] self-center" opts={{ align: "start" }}>
        <CarouselContent>
          {["Ưu đãi 50%", "Hoàn tiền 10%", "Miễn phí rút", "Tích điểm x2"].map((t) => (
            <CarouselItem key={t} className="basis-1/2">
              <Card className="aspect-square">
                <CardContent className="grid h-full place-items-center p-2 text-center text-sm font-medium">{t}</CardContent>
              </Card>
            </CarouselItem>
          ))}
        </CarouselContent>
        <CarouselPrevious />
        <CarouselNext />
      </Carousel>
    </Section>
  );
}

function App() {
  const [dark, setDark] = useState(true);
  React.useEffect(() => {
    document.documentElement.classList.toggle("dark", dark);
  }, [dark]);

  return (
    <TooltipProvider>
      <div className="min-h-screen w-full px-5 py-8 md:px-10">
        <header className="mx-auto mb-8 flex max-w-[1400px] flex-wrap items-center justify-between gap-4">
          <div className="flex items-center gap-3">
            <div className="grid size-11 place-items-center rounded-2xl bg-primary text-primary-foreground shadow-lg"><I.Wallet /></div>
            <div>
              <h1 className="type-heading-small font-display">VNPAY Glass — Component Showcase</h1>
              <p className="type-body-small text-muted-foreground">40 component · Base UI · composition “VNPAY Glass” (Payment Glass Pro + VNPAY Merchant, KG)</p>
            </div>
          </div>
          <Button variant="outline" onClick={() => setDark((d) => !d)}>
            {dark ? <I.Sun /> : <I.Moon />} {dark ? "Light" : "Dark"}
          </Button>
        </header>

        <main className="mx-auto grid max-w-[1400px] grid-cols-1 gap-5 md:grid-cols-2 xl:grid-cols-3">
          <ButtonsDemo />
          <BadgesDemo />
          <CardDemo />
          <AlertDemo />
          <AvatarDemo />
          <AccordionDemo />
          <TabsDemo />
          <CollapsibleDemo />
          <TogglesDemo />
          <SliderProgressDemo />
          <InputsDemo />
          <OtpDemo />
          <SelectDemo />
          <FieldDemo />
          <OverlaysDemo />
          <PopoversDemo />
          <CommandDemo />
          <TableDemo />
          <NavDemo />
          <MiscDemo />
          <CarouselDemo />
        </main>

        <footer className="mx-auto mt-10 max-w-[1400px] text-center text-xs text-muted-foreground">
          Tokens pulled verbatim from sm-mcp Knowledge Graph · composition “VNPAY Glass”.
        </footer>
      </div>
    </TooltipProvider>
  );
}

createRoot(document.getElementById("root")).render(<App />);
