<!-- GENERATED bởi scripts/gen-wire-doc.mjs — ĐỪNG sửa tay.
     Nguồn sự thật: references/wire-registry.json -->
# Từ vựng component wireframe (DSL v2)

Đây là **danh sách ĐÓNG**. Slug không có trong bảng sẽ bị
`scripts/validate-wire.mjs` báo lỗi và renderer vẽ ra badge đỏ `?slug` — không
im lặng ra hộp rỗng như DSL v1.

Prop có dấu **\*** là **bắt buộc**. Mọi leaf còn nhận thêm prop chung:
`label` (string?) · `grow` (number?) · `w` (number?) · `note` (string?).

Cột **→ ui-react / ui-html / ui-rn** là hợp đồng bàn giao: bước UI dựng đúng
component đó, không tự chọn lại.

## shadcn — 1:1 với `src/components/ui/*` của terminal `ui-react`

| Slug | Props | Từ vựng v1 (cũ) | → ui-react | → ui-html | → ui-rn |
|---|---|---|---|---|---|
| `shadcn:Heading` | `label`**\*** | `heading` `title` | `plain <h2> + type-title utility` | `<h1>…<h3>` | `gluestack Heading` |
| `shadcn:Text` | `label`**\*** | `text` `paragraph` `content` | `plain <p> + text-muted-foreground` | `<p>` | `gluestack Text` |
| `shadcn:Label` | `label`**\*** `required` | `label` | `@/components/ui/label → Label` | `<label>` | `gluestack FormControlLabel` |
| `shadcn:Link` | `label`**\*** `navigatesTo` | `link` `anchor` | `Button variant="link" or react-router <Link>` | `<a>` | `Pressable + Text` |
| `shadcn:Input` | `label` `placeholder` `hint` `required` `invalid` | `input` `textinput` `textfield` | `@/components/ui/input → Input (wrap in Field for label/error)` | `<label> + <input>` | `gluestack Input + InputField` |
| `shadcn:InputSearch` | `placeholder` `hint` | `search` `searchbox` | `InputGroup + InputGroupAddon(Search) + InputGroupInput` | `<input type=search> + icon` | `Input + InputSlot + InputIcon` |
| `shadcn:Textarea` | `label` `placeholder` `hint` `required` | `textarea` | `@/components/ui/textarea → Textarea` | `<textarea>` | `gluestack Textarea` |
| `shadcn:Select` | `label` `placeholder` `options` `required` | `select` `dropdown` `combobox` `picker` | `@/components/ui/select → Select/SelectTrigger/SelectContent/SelectItem` | `<select>` | `gluestack Select` |
| `shadcn:Checkbox` | `label`**\*** `checked` | `checkbox` | `@/components/ui/checkbox → Checkbox` | `<input type=checkbox>` | `gluestack Checkbox` |
| `shadcn:RadioGroup` | `label` `items` `active` | `radio` `radiogroup` | `@/components/ui/radio-group → RadioGroup/RadioGroupItem` | `<input type=radio> group` | `gluestack Radio` |
| `shadcn:Switch` | `label`**\*** `checked` | `toggle` `switch` | `@/components/ui/switch → Switch` | `<input type=checkbox role=switch>` | `gluestack Switch` |
| `shadcn:Slider` | `label` `value` `maxValue` | `slider` `range` | `@/components/ui/slider → Slider` | `<input type=range>` | `gluestack Slider` |
| `shadcn:InputOTP` | `label` `length` | `otp` `inputotp` `pin` | `@/components/ui/input-otp → InputOTP/InputOTPSlot` | `row of <input maxlength=1>` | `row of Input (no gluestack OTP)` |
| `shadcn:Button` | `label`**\*** `variant` `size` `icon` `block` `navigatesTo` | `button` `cta` | `@/components/ui/button → Button` | `<button>` | `gluestack Button + ButtonText` |
| `shadcn:Badge` | `label`**\*** `variant` | `chip` `tag` `badge` | `@/components/ui/badge → Badge` | `<span class=badge>` | `gluestack Badge` |
| `shadcn:ToggleGroup` | `items`**\*** `active` | `chips` `chipgroup` `togglegroup` `segmented` | `@/components/ui/toggle-group → ToggleGroup/ToggleGroupItem` | `row of <button aria-pressed>` | `gluestack ButtonGroup` |
| `shadcn:Tabs` | `items`**\*** `active` | `tabs` `tabbar` | `@/components/ui/tabs → Tabs/TabsList/TabsTrigger` | `<div role=tablist>` | `gluestack Tabs` |
| `shadcn:NavigationMenu` | `label` `items` | `navbar` `topnav` `header` | `@/components/ui/navigation-menu → NavigationMenu` | `<header><nav>` | `— web pattern, use mobile:AppBar instead` |
| `shadcn:Breadcrumb` | `items`**\*** | `breadcrumb` `crumbs` | `@/components/ui/breadcrumb → Breadcrumb…` | `<nav aria-label=breadcrumb>` | `— web pattern` |
| `shadcn:Pagination` | `pages` `active` | `pagination` `pager` | `@/components/ui/pagination → Pagination…` | `<nav> of page links` | `— use infinite scroll on mobile` |
| `shadcn:Sidebar` | `label` `items`**\*** `active` | `sidebar` `sidenav` | `@/components/ui/sidebar → Sidebar…` | `<aside><nav>` | `— becomes mobile:NavDrawer or mobile:BottomNav` |
| `shadcn:Accordion` | `items`**\*** `active` | `accordion` `collapsible` `disclosure` | `@/components/ui/accordion → Accordion…` | `<details>/<summary>` | `gluestack Accordion` |
| `shadcn:Item` | `items`**\*** `navigatesTo` | `list` `item` `listitem` `rows` | `@/components/ui/item → Item/ItemContent (map over data)` | `<ul><li> rows` | `FlatList + Pressable rows` |
| `shadcn:Table` | `columns`**\*** `rows` | `table` `datagrid` `grid` | `@/components/ui/table → Table/TableHeader/TableRow/TableCell` | `<table>` | `— becomes a card list on mobile` |
| `shadcn:Card` | `label` `hint` | `card` `panel` | `@/components/ui/card → Card/CardHeader/CardContent` | `<section class=card>` | `gluestack Card` |
| `shadcn:Progress` | `label` `progress` | `progress` `progressbar` | `@/components/ui/progress → Progress` | `<progress>` | `gluestack Progress` |
| `shadcn:Skeleton` | `lines` | `skeleton` `placeholder` `loading` | `@/components/ui/skeleton → Skeleton` | `<div class=skeleton>` | `gluestack Skeleton` |
| `shadcn:Empty` | `label`**\*** `hint` | `empty` `emptystate` `nodata` | `@/components/ui/empty → Empty…` | `<div class=empty>` | `VStack + Icon + Text` |
| `shadcn:Avatar` | `label` | `avatar` `profilepic` | `@/components/ui/avatar → Avatar/AvatarFallback` | `<img class=avatar>` | `gluestack Avatar` |
| `shadcn:Separator` | — | `divider` `separator` `hr` | `@/components/ui/separator → Separator` | `<hr>` | `gluestack Divider` |
| `shadcn:Alert` | `label`**\*** `alertType` | `alert` `banner` `callout` `toast` | `@/components/ui/alert → Alert/AlertTitle/AlertDescription` | `<div role=alert>` | `gluestack Alert` |

## mobile — shadcn KHÔNG có các primitive này; đây là phần mở rộng có chủ đích

| Slug | Props | Từ vựng v1 (cũ) | → ui-react | → ui-html | → ui-rn |
|---|---|---|---|---|---|
| `mobile:AppBar` | `label`**\*** `back` `menu` `action` | `appbar` `topbar` | `compose: sticky div + Button size=icon` | `<header> sticky` | `expo-router Stack.Screen header / gluestack HStack` |
| `mobile:BottomNav` | `items`**\*** `active` | `bottomnav` `tabbarbottom` `navbottom` | `compose: fixed bottom bar (mobile layout only)` | `<nav> fixed bottom` | `expo-router Tabs` |
| `mobile:Fab` | `icon` `label` `navigatesTo` | `fab` `floatingbutton` | `Button size=icon + fixed positioning` | `<button class=fab>` | `gluestack Fab` |
| `mobile:NavDrawer` | `label` `items`**\*** `active` | `drawer` `navdrawer` `sidedrawer` | `@/components/ui/sheet → Sheet side=left` | `off-canvas <nav> + scrim` | `expo-router Drawer` |
| `mobile:ActionSheet` | `items`**\*** `label` | `actionsheet` `sheetactions` | `@/components/ui/drawer → Drawer (vaul, bottom)` | `bottom sheet list` | `gluestack Actionsheet` |

## data — không có primitive, terminal tự compose

| Slug | Props | Từ vựng v1 (cũ) | → ui-react | → ui-html | → ui-rn |
|---|---|---|---|---|---|
| `data:Stat` | `label`**\*** `hint` | `stat` `kpi` `metric` | `Card + type-display value (compose, no primitive)` | `<dl> stat block` | `VStack + Text` |
| `data:Stepper` | `items`**\*** `activeStep` | `stepper` `steps` `wizard` | `compose (no shadcn primitive) — Badge + Separator row` | `<ol class=stepper>` | `HStack of numbered circles` |

## media

| Slug | Props | Từ vựng v1 (cũ) | → ui-react | → ui-html | → ui-rn |
|---|---|---|---|---|---|
| `media:Image` | `label` | `image` `illustration` `photo` `banner` | `<img> + AspectRatio` | `<img>` | `expo-image` |

## layout

| Slug | Props | Từ vựng v1 (cũ) | → ui-react | → ui-html | → ui-rn |
|---|---|---|---|---|---|
| `layout:SectionLabel` | `label`**\*** | `section` `sectionlabel` | `plain <h3> above a group` | `<h3> section heading` | `Text (section heading)` |
| `layout:Spacer` | — | `spacer` `gap` | `flex-1 spacer div` | `margin utility` | `gluestack Spacer` |

## Ghi chú

- **Overlay không phải leaf.** Dialog / sheet / drawer là MỘT MÀN riêng, khai bằng
  `overlay` + `overlayOf` ở cấp document (xem `wireframe.md`). `mobile:NavDrawer`
  là ngoại lệ duy nhất: nó vẽ menu điều hướng ở trạng thái mở.
- **File cũ vẫn chạy**: renderer nhận từ vựng v1 qua cột "Từ vựng v1", validator
  báo cảnh báo kèm slug v2 tương ứng. Không cần script migrate.
- Thêm slug mới: sửa `wire-registry.json` → chạy `gen-wire-doc.mjs` → đồng bộ
  renderer (`npm run sync:wire-registry` bên pipeline-studio).
