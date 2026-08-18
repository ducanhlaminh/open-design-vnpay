---
name: ds-criteria-extract
description: |
  Sinh danh mục component hợp lệ cho Design System Figma từ react/docs/catalog.md,
  dùng STYLE-GUIDE.md để hiểu token khi cần, và ghi kết quả an toàn vào
  criteria/components.md.next để daemon validate trước khi thay thế components.md.
  Đây là bước chuẩn bị criteria cho workflow docs-review; không sinh rules.md và
  không viết các quy tắc UX suy diễn từ Figma.
triggers:
  - "sinh criteria component từ Figma"
  - "trích danh mục component design system"
  - "tạo components.md cho design system"
  - "ds criteria extract"
  - "DS Figma criteria"
od:
  mode: utility
  category: design-systems
---

# ds-criteria-extract — sinh danh mục component từ DS Figma

Bạn là bước sinh **danh mục component hợp lệ** cho một Design System Figma. Cwd
của bạn là thư mục gốc của DS, không phải thư mục repo Open Design. Nhiệm vụ là
đọc export thật, lọc và gom các component thành một file Markdown để bước
`docs-screen-components` dùng khi đề xuất component cho màn hình. Bạn không review tài liệu
nghiệp vụ, không sinh `rules.md`, không thiết kế thêm component và không bịa quy
tắc UX.

## Input (đọc từ cwd của DS)

Đọc các nguồn sau, theo đúng vai trò:

- `react/docs/catalog.md` là nguồn **chính**. Mỗi heading `## <Name>` là một
  component thô. Đọc tên, mô tả nếu có, bảng
  `| prop | type | default | options |` và dòng `Variants exported: N`.
  Giá trị trong cột `options` là dữ liệu nguồn, không được thay bằng suy đoán.
- `react/STYLE-GUIDE.md` là hợp đồng token. Đọc khi cần kiểm tra hoặc mô tả
  kích thước, màu semantic, typography, spacing, radius; file này có thể cho
  biết token contract (ví dụ số lượng màu, typography, spacing, radius), nhưng
  không tự tạo thêm component hay variant.
- `DESIGN.md` là nguồn tên Design System dùng trong tiêu đề output. Lấy tên DS
  theo nội dung file, không đoán từ tên thư mục nếu `DESIGN.md` đã nêu tên rõ.

Nếu một input bắt buộc không đọc được, nói rõ thiếu nguồn thay vì dựng danh mục
bằng trí nhớ. Không đọc các file trong repo ứng dụng để bù cho catalog của DS.

## Output và ghi an toàn

Chỉ tạo đúng một file:

`criteria/components.md.next`

Tạo thư mục `criteria/` nếu cần. **Tuyệt đối không ghi đè
`criteria/components.md`**. Daemon sẽ validate `.next`, rồi mới rename an toàn
thành `components.md`; không tự rename, không tự xoá file cũ, không tạo
`rules.md`, `_meta.json` hay file phụ nào khác. Nếu đang có output cũ, chỉ thay
file `.next` do lần chạy này sinh ra.

Output là Markdown tiếng Việt, bám sát bố cục và cách trình bày của file mẫu
`criteria/components.md` mà downstream tiêu thụ. Anchor component là hợp đồng
máy đọc, không phải trang trí Markdown.

## Bố cục bắt buộc của output

Dùng cấu trúc sau. Các nhóm rỗng phải bỏ hẳn; không để heading nhóm không có
component. Tên DS trong dòng đầu lấy từ `DESIGN.md`.

```markdown
# Danh mục component hợp lệ — <tên DS>

## Cách dùng file này khi review tài liệu
Đây là tập đóng các component được phép xuất hiện trong tài liệu.
Tên trong tài liệu và tên ở đây có thể không trùng chữ; hãy map theo nghĩa.
Thành phần không có trong danh mục là not-in-catalog.

## Danh sách theo nhóm
- CONTROL → Button, Chip

## CONTROL
### `#button` Button
Component điều khiển hành động tương tác trên màn hình.
- **Button** — Type: Primary, Secondary · State: Default, Disable

## DATA DISPLAY
### `#card` Card
Component trình bày một khối nội dung liên quan.

## FEEDBACK
### `#alert` Alert
Băng thông báo nội tuyến trong trang.
```

Bố cục thực tế phải có đủ các phần đang dùng, theo thứ tự nhóm cố định:
`CONTROL`, `DATA DISPLAY`, `FEEDBACK`, `NAVIGATION`, `INPUT`, `LAYOUT`,
`OVERLAY`. Không bắt buộc tạo phần `COMPOSITE / TEMPLATES`; nếu component
composite thực sự là một mẫu màn hình, có thể xếp vào nhóm gần nhất theo công
 dụng, nhưng phải nêu căn cứ từ catalog và không tạo nhóm ngoài bộ nhóm trên.

Phần “Cách dùng file này khi review” dài 3–6 dòng, giải thích đây là tập ĐÓNG
component được phép xuất hiện trong tài liệu, tên có thể khác nhau nhưng phải
map theo **NGHĨA**, và thứ không có trong danh mục là `not-in-catalog`. Phần
“Danh sách theo nhóm” là index gạch đầu dòng, mỗi dòng nêu nhóm và tên các
component đã xuất hiện bên dưới.

Mỗi component phải có đúng một heading cấp 3 theo mẫu
`### \`#<slug>\` <Tên>`, một mô tả tiếng Việt ngắn 1–3 câu nói component là gì
hoặc dùng để làm gì, và chỉ các dòng biến thể có căn cứ. Không biến heading
cấp 3 thành heading phụ cho variant.

## Luật cứng

### 1. Anchor là định danh bắt buộc

Mỗi component dùng đúng mẫu:

`### \`#<slug>\` <Tên>`

Trong đó `<slug>` là kebab-case suy từ tên component đã gộp, ví dụ `Button`
thành `button`, `Input Field` thành `input-field`, `Checkbox / Radio /
Switch` thành `checkbox-radio-switch`. Slug chỉ được dùng **một lần trong
toàn file**. Backtick mở ngay trước `#` và đóng ngay sau slug là bắt buộc:
daemon parse token backtick đó để tạo `rule_id` dạng
`criteria/components.md#<slug>`. Không dùng anchor ở dòng `#` hoặc `##`.

**Chỉ heading `###` mới là component.** Heading `#` chỉ dành cho tiêu đề file;
heading `##` chỉ dành cho tên phần và nhóm. Không đặt anchor component trên
heading `#`/`##`, và không tạo component bằng bullet, bảng hoặc heading cấp khác.

### 2. Không bịa component

Mỗi heading `###` phải truy ngược được về ít nhất một heading `## <Name>` trong
`react/docs/catalog.md`. Tên output có thể là tên chuẩn hóa để gom họ, nhưng
phải ghi các tên/biến thể nguồn ở bullet của chính component đó hoặc có căn cứ
rõ ràng trong catalog. Không biến utility, icon, token, demo, khung trang trí
thành component tài liệu chỉ vì catalog có heading cho chúng.

### 3. Không bịa variant hoặc state

Chỉ ghi variant/state khi bảng prop của component nguồn có `type: VARIANT` (hoặc
prop variant tương đương) và copy **nguyên văn** toàn bộ danh sách trong cột
`options`, giữ nguyên chữ hoa/thường, dấu câu, khoảng trắng, dấu gạch, và thứ
tự. Ví dụ định dạng là:

`- **<Tên biến thể>** — <Prop>: <options nguyên văn> · <Prop>: <options nguyên văn>`

Không dịch tên option, không rút gọn thành “v.v.”, không lấy giá trị `default`
làm option mới, không suy ra state từ mô tả tiếng Anh, token hoặc tên file. Nếu
bảng không có prop VARIANT thì **chỉ viết mô tả**, không bịa dòng biến thể.
Props `TEXT`, `BOOLEAN`, `INSTANCE_SWAP` và số `Variants exported` tự chúng
không phải variant để liệt kê. Chỉ mô tả semantic size/màu khi có căn cứ trong
catalog hoặc STYLE-GUIDE; không thêm kích thước, màu, typography, spacing,
radius hay trạng thái từ thói quen UX.

### 4. Lọc rác theo công dụng sản phẩm

Giữ những thứ một màn hình sản phẩm có thể dựng trực tiếp và người dùng/tài
liệu nghiệp vụ có thể gọi tên: control, input, data display, feedback,
navigation, layout, overlay và mẫu giao diện có vai trò rõ ràng. Bỏ những thứ
chỉ phục vụ mockup hoặc export nội bộ, cụ thể:

- chrome thiết bị như `IOSStatusBar`, `IOSIndicator`, `IOSKeyboard`,
  `IOSFaceId`, `AndroidStatusBar`;
- badge cửa hàng như `StoreBadge`;
- mọi component có đuôi `_example`, mọi component nằm trong `examples/`;
- utility phục vụ trang catalog, demo, đo đạc, palette, changelog, node/flow
  minh họa, icon/emoji độc lập và mảnh dựng nội bộ nếu không phải component
  người dùng thấy.

Không chỉ chép danh sách tên bị lọc; trong phần ghi chú phương pháp của skill
này phải giữ tiêu chí: **giữ thứ một màn hình sản phẩm dựng từ đó, bỏ thứ chỉ
trang trí mockup**. Một component có tên “Utility” nhưng thật sự là control
người dùng thấy thì xét theo vai trò và căn cứ catalog, không lọc máy móc theo
chuỗi tên.

### 5. Gom nhóm theo công dụng

Mỗi component output nằm trong đúng một trong các nhóm `CONTROL`, `DATA
DISPLAY`, `FEEDBACK`, `NAVIGATION`, `INPUT`, `LAYOUT`, `OVERLAY`. Chọn nhóm
theo vai trò của nó trong màn hình, không theo vị trí ngẫu nhiên trong catalog.
Nếu nhóm không có component sau lọc thì bỏ heading nhóm đó.

### 6. Gộp các component cùng họ

Catalog Figma thường tách một họ thành nhiều heading `##`, chẳng hạn `Button`,
`FaB`, `Hyperlink`, hoặc các phần `Card*`, `Upload*`, `Progress*`. Gộp chúng
thành một component output và nhiều bullet `- **<Tên>**` khi chúng có **cùng
vai trò trong màn hình** và chỉ khác kiểu trình bày/biến thể. Mỗi bullet vẫn lấy
option nguyên văn từ bảng của heading nguồn tương ứng.

Tách thành component khác khi khác vai trò người dùng, khác cách tài liệu gọi
đến, hoặc việc gộp làm mất khả năng map chính xác. Không gộp chỉ vì tên gần
nhau. Nêu tiêu chí này trong cách xử lý: cùng vai trò thì gộp, khác vai trò thì
tách. Tên output dùng tên họ dễ hiểu; không dùng tên nội bộ làm anchor nếu có
tên component công khai phù hợp.

### 7. Mô tả phải là mô tả, không phải quy tắc UX

Mô tả bằng tiếng Việt, ngắn, nói component **là gì / làm công dụng gì**, dựa
trên catalog. Có thể dịch hoặc viết lại description tiếng Anh cụt/rỗng để
người đọc nghiệp vụ hiểu, nhưng không thêm thông tin không có căn cứ.

CẤM viết quy tắc dùng, điều kiện chọn component, thứ tự thao tác, hoặc tiêu chí
bắt buộc trong sản phẩm; ví dụ không viết “form dài thì dùng Drawer”, “chỉ dùng
Modal khi…”, “mỗi màn hình phải có…”, hay “hãy dùng Button này thay Button kia”.
Các quy tắc UX thuộc `criteria/rules.md`, là file người dùng nạp riêng và
không được suy ra từ Figma export. Các câu trong output chỉ được mô tả component
và các option đã đọc được.

## Quy trình thực hiện

1. Đọc `DESIGN.md`, `react/docs/catalog.md` và phần liên quan của
   `react/STYLE-GUIDE.md` trước khi viết. Lập danh sách tất cả heading `##`,
   sau đó đánh dấu: giữ, gộp, hoặc lọc; không lấy số component thô làm số output.
2. Với từng heading được giữ, đọc bảng prop và tách chính xác các prop
   `VARIANT`. Ghi lại options nguyên văn trước khi dịch mô tả. Khi gộp, giữ
   mapping từ mỗi bullet output về một hoặc nhiều heading nguồn.
3. Xếp các component đã giữ vào đúng nhóm công dụng. Tạo slug kebab-case duy
   nhất cho component output; kiểm tra cả component gộp để không trùng slug.
4. Viết output tiếng Việt theo bố cục mẫu, trong đó index nhóm phải khớp các
   heading component thực tế. Không thêm một heading cấp 3 cho nhóm, phần
   utility hoặc biến thể riêng lẻ.
5. Ghi chỉ `criteria/components.md.next`. Không ghi `components.md` dù file đó
   chưa tồn tại; daemon là nơi validate và rename.

Quy mô tự kiểm tham khảo: từ khoảng 251 component thô, output hợp lý thường có
**40–80 component** sau lọc và gom. Hơn 150 thường nghĩa là chưa lọc/chưa gộp;
dưới 25 thường nghĩa là lọc quá tay. Đây là **mốc tham khảo, không phải hạn
mức cứng** — Design System thật sự nhỏ thì ít hơn là đúng. Quan trọng nhất vẫn
là mọi component có nguồn truy vết và output phục vụ được tài liệu nghiệp vụ.

## Tự kiểm cuối trước khi kết thúc

Trước khi kết thúc, agent phải đọc lại `.next` và tự soát tất cả điều sau:

- Mọi dòng bắt đầu bằng `### ` đều có đúng một token backtick mở đầu bằng `#`,
  theo đúng mẫu `### \`#slug\` Tên`; không có anchor trên `#` hoặc `##`.
- Không có anchor/slug nào trùng trong toàn file; slug đều kebab-case và
  `rule_id` tương ứng sẽ là `criteria/components.md#<slug>`.
- Mọi component output đều có thể truy về một hoặc nhiều heading `##` có thật
  trong `react/docs/catalog.md`; không còn chrome thiết bị, StoreBadge, demo,
  examples hoặc rác mockup.
- Mọi option trong bullet variant là bản copy nguyên văn từ cột `options`; nơi
  catalog không có prop VARIANT chỉ có mô tả, không có variant/state bịa.
- Index nhóm khớp các heading component, nhóm rỗng đã bỏ, và không có nhóm ngoài
  bộ nhóm quy định.
- Không có câu nào đang phát biểu QUY TẮC UX thay vì mô tả component.
- File duy nhất được tạo hoặc thay đổi là `criteria/components.md.next`; không
  ghi đè `criteria/components.md`, không tạo `rules.md`, và không commit.
