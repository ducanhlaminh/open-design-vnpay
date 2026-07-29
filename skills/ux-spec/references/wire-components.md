<!-- GENERATED bởi scripts/gen-wire-doc.mjs — ĐỪNG sửa tay.
     Nguồn sự thật: references/wire-registry.json -->
# Từ vựng component wireframe (DSL v2)

Đây là **danh sách ĐÓNG**. Slug không có trong bảng sẽ bị
`scripts/validate-wire.mjs` báo lỗi và renderer vẽ ra badge đỏ `?slug` — không
im lặng ra hộp rỗng như DSL v1.

Prop có dấu **\*** là **bắt buộc**. Mọi leaf còn nhận thêm prop chung:
`label` (string?) · `grow` (number?) · `w` (number?) · `note` (string?) · `comp` (string?).

Cột **→ ui-react / ui-html** là hợp đồng bàn giao: bước UI dựng đúng
component đó, không tự chọn lại.

## shadcn — 1:1 với `src/components/ui/*` của terminal `ui-react`

| Slug | Props | Từ vựng v1 (cũ) | → ui-react | → ui-html |
|---|---|---|---|---|
| `shadcn:Heading` | `label`**\*** | `heading` `title` | `plain <h2> + type-title utility` | `<h1>…<h3>` |
| `shadcn:Text` | `label`**\*** | `text` `paragraph` `content` | `plain <p> + text-muted-foreground` | `<p>` |
| `shadcn:Label` | `label`**\*** `required` | `label` | `@/components/ui/label → Label` | `<label>` |
| `shadcn:Link` | `label`**\*** `navigatesTo` | `link` `anchor` | `Button variant="link" or react-router <Link>` | `<a>` |
| `shadcn:Input` | `label` `placeholder` `hint` `required` `invalid` | `input` `textinput` `textfield` | `@/components/ui/input → Input (wrap in Field for label/error)` | `<label> + <input>` |
| `shadcn:InputSearch` | `placeholder` `hint` | `search` `searchbox` | `InputGroup + InputGroupAddon(Search) + InputGroupInput` | `<input type=search> + icon` |
| `shadcn:Textarea` | `label` `placeholder` `hint` `required` | `textarea` | `@/components/ui/textarea → Textarea` | `<textarea>` |
| `shadcn:Select` | `label` `placeholder` `options` `required` | `select` `dropdown` `combobox` `picker` | `@/components/ui/select → Select/SelectTrigger/SelectContent/SelectItem` | `<select>` |
| `shadcn:Checkbox` | `label`**\*** `checked` | `checkbox` | `@/components/ui/checkbox → Checkbox` | `<input type=checkbox>` |
| `shadcn:RadioGroup` | `label` `items` `active` | `radio` `radiogroup` | `@/components/ui/radio-group → RadioGroup/RadioGroupItem` | `<input type=radio> group` |
| `shadcn:Switch` | `label`**\*** `checked` | `toggle` `switch` | `@/components/ui/switch → Switch` | `<input type=checkbox role=switch>` |
| `shadcn:Slider` | `label` `value` `maxValue` | `slider` `range` | `@/components/ui/slider → Slider` | `<input type=range>` |
| `shadcn:InputOTP` | `label` `length` | `otp` `inputotp` `pin` | `@/components/ui/input-otp → InputOTP/InputOTPSlot` | `row of <input maxlength=1>` |
| `shadcn:Button` | `label`**\*** `variant` `size` `icon` `block` `navigatesTo` | `button` `cta` | `@/components/ui/button → Button` | `<button>` |
| `shadcn:Badge` | `label`**\*** `variant` | `chip` `tag` `badge` | `@/components/ui/badge → Badge` | `<span class=badge>` |
| `shadcn:ToggleGroup` | `items`**\*** `active` | `chips` `chipgroup` `togglegroup` `segmented` | `@/components/ui/toggle-group → ToggleGroup/ToggleGroupItem` | `row of <button aria-pressed>` |
| `shadcn:Tabs` | `items`**\*** `active` | `tabs` `tabbar` | `@/components/ui/tabs → Tabs/TabsList/TabsTrigger` | `<div role=tablist>` |
| `shadcn:NavigationMenu` | `label` `items` | `navbar` `topnav` `header` | `@/components/ui/navigation-menu → NavigationMenu` | `<header><nav>` |
| `shadcn:Breadcrumb` | `items`**\*** | `breadcrumb` `crumbs` | `@/components/ui/breadcrumb → Breadcrumb…` | `<nav aria-label=breadcrumb>` |
| `shadcn:Pagination` | `pages` `active` | `pagination` `pager` | `@/components/ui/pagination → Pagination…` | `<nav> of page links` |
| `shadcn:Sidebar` | `label` `items`**\*** `active` | `sidebar` `sidenav` | `@/components/ui/sidebar → Sidebar…` | `<aside><nav>` |
| `shadcn:Accordion` | `items`**\*** `active` | `accordion` `collapsible` `disclosure` | `@/components/ui/accordion → Accordion…` | `<details>/<summary>` |
| `shadcn:Item` | `items`**\*** `navigatesTo` | `list` `item` `listitem` `rows` | `@/components/ui/item → Item/ItemContent (map over data)` | `<ul><li> rows` |
| `shadcn:Table` | `columns`**\*** `rows` | `table` `datagrid` `grid` | `@/components/ui/table → Table/TableHeader/TableRow/TableCell` | `<table>` |
| `shadcn:Card` | `label` `hint` | `card` `panel` | `@/components/ui/card → Card/CardHeader/CardContent` | `<section class=card>` |
| `shadcn:Progress` | `label` `progress` | `progress` `progressbar` | `@/components/ui/progress → Progress` | `<progress>` |
| `shadcn:Skeleton` | `lines` | `skeleton` `placeholder` `loading` | `@/components/ui/skeleton → Skeleton` | `<div class=skeleton>` |
| `shadcn:Empty` | `label`**\*** `hint` | `empty` `emptystate` `nodata` | `@/components/ui/empty → Empty…` | `<div class=empty>` |
| `shadcn:Avatar` | `label` | `avatar` `profilepic` | `@/components/ui/avatar → Avatar/AvatarFallback` | `<img class=avatar>` |
| `shadcn:Separator` | — | `divider` `separator` `hr` | `@/components/ui/separator → Separator` | `<hr>` |
| `shadcn:Alert` | `label`**\*** `alertType` | `alert` `banner` `callout` `toast` | `@/components/ui/alert → Alert/AlertTitle/AlertDescription` | `<div role=alert>` |

## mobile — shadcn KHÔNG có các primitive này; đây là phần mở rộng có chủ đích

| Slug | Props | Từ vựng v1 (cũ) | → ui-react | → ui-html |
|---|---|---|---|---|
| `mobile:AppBar` | `label`**\*** `back` `menu` `action` | `appbar` `topbar` | `compose: sticky div + Button size=icon` | `<header> sticky` |
| `mobile:BottomNav` | `items`**\*** `active` | `bottomnav` `tabbarbottom` `navbottom` | `compose: fixed bottom bar (mobile layout only)` | `<nav> fixed bottom` |
| `mobile:Fab` | `icon` `label` `navigatesTo` | `fab` `floatingbutton` | `Button size=icon + fixed positioning` | `<button class=fab>` |
| `mobile:NavDrawer` | `label` `items`**\*** `active` | `drawer` `navdrawer` `sidedrawer` | `@/components/ui/sheet → Sheet side=left` | `off-canvas <nav> + scrim` |
| `mobile:ActionSheet` | `items`**\*** `label` | `actionsheet` `sheetactions` | `@/components/ui/drawer → Drawer (vaul, bottom)` | `bottom sheet list` |

## data — không có primitive, terminal tự compose

| Slug | Props | Từ vựng v1 (cũ) | → ui-react | → ui-html |
|---|---|---|---|---|
| `data:Stat` | `label`**\*** `hint` | `stat` `kpi` `metric` | `Card + type-display value (compose, no primitive)` | `<dl> stat block` |
| `data:Stepper` | `items`**\*** `activeStep` | `stepper` `steps` `wizard` | `compose (no shadcn primitive) — Badge + Separator row` | `<ol class=stepper>` |

## media

| Slug | Props | Từ vựng v1 (cũ) | → ui-react | → ui-html |
|---|---|---|---|---|
| `media:Image` | `label` | `image` `illustration` `photo` `banner` | `<img> + AspectRatio` | `<img>` |

## layout

| Slug | Props | Từ vựng v1 (cũ) | → ui-react | → ui-html |
|---|---|---|---|---|
| `layout:SectionLabel` | `label`**\*** | `section` `sectionlabel` | `plain <h3> above a group` | `<h3> section heading` |
| `layout:Spacer` | — | `spacer` `gap` | `flex-1 spacer div` | `margin utility` |

## Ghi chú

- **Overlay không phải leaf.** Dialog / sheet / drawer là MỘT MÀN riêng, khai bằng
  `overlay` + `overlayOf` ở cấp document (xem `wireframe.md`). `mobile:NavDrawer`
  là ngoại lệ duy nhất: nó vẽ menu điều hướng ở trạng thái mở.
- **File cũ vẫn chạy**: renderer nhận từ vựng v1 qua cột "Từ vựng v1", validator
  báo cảnh báo kèm slug v2 tương ứng. Không cần script migrate.
- Thêm slug mới: sửa `wire-registry.json` → chạy `gen-wire-doc.mjs` → đồng bộ
  renderer (`npm run sync:wire-registry` bên pipeline-studio).
