# Hướng dẫn sử dụng Open Design

> Xem nhanh dưới dạng trình chiếu: [Slideshow hướng dẫn Open Design](../slides/open-design-user-guide/README.md).

Tài liệu này dành cho Designer, BA, PO và người review tài liệu. Bạn không cần
biết lập trình để sử dụng các chức năng chính.

## 1. Open Design dùng để làm gì?

Open Design giúp bạn:

- Tạo **Dự án** và chia công việc thành các **Tính năng**.
- Nạp URD/PRD từ Confluence hoặc từ tệp trên máy.
- Chạy quy trình để tạo UI-Spec, rà soát yêu cầu hoặc rà soát tài liệu.
- Xem và chỉnh sửa kết quả trước khi xác nhận.
- Quản lý Design System Figma và tài liệu hướng dẫn thiết kế.
- Chia sẻ kết quả lên kho chung để người khác tiếp tục làm việc.
- Lấy Dự án hoặc Design System đã chia sẻ về máy.

### Ba khái niệm cần nhớ

| Khái niệm | Ý nghĩa |
| --- | --- |
| **Dự án** | Sản phẩm hoặc phạm vi công việc lớn, ví dụ “Kế toán”. |
| **Tính năng** | Một yêu cầu hoặc luồng nghiệp vụ độc lập trong Dự án, ví dụ “Thanh toán”. Mỗi Tính năng có thể chạy các quy trình riêng. |
| **Kho chung** | Nơi lưu bản đã chia sẻ để đồng nghiệp có quyền có thể xem hoặc lấy về máy. |

> Open Design là nơi tạo và chạy công việc. Kho chung chỉ giữ các bản đã được
> chia sẻ; dữ liệu đang làm trên máy không tự động xuất hiện trong kho chung.

## 2. Chuẩn bị lần đầu

### Bước 1 — Mở Open Design

Cài và mở bản Open Design dành cho hệ điều hành của bạn. Ở lần chạy đầu, ứng
dụng kiểm tra Docker và môi trường chạy trợ lý AI.

Nếu máy chưa có Docker:

1. Chọn **Cài Docker tự động**.
2. Nhập mật khẩu máy nếu hệ điều hành yêu cầu.
3. Mở Docker Desktop sau khi cài.
4. Chờ đến khi Docker báo đang chạy rồi quay lại Open Design.

Trên Windows, máy phải bật Virtualization/VT trong BIOS. Nếu vừa bật VT, hãy
khởi động lại Windows trước khi kiểm tra lại.

### Bước 2 — Đăng nhập Open Design

Đăng nhập bằng tài khoản Google công ty. Tài khoản này dùng để xác định quyền
truy cập kho chung.

Nếu ứng dụng báo chưa kết nối với kho Dự án, chọn **Kết nối lại**. Bạn vẫn có
thể làm việc với dữ liệu trên máy khi kho chung tạm thời không khả dụng, nhưng chưa
thể Chia sẻ hoặc Lấy Dự án.

### Bước 3 — Đăng nhập Claude hoặc Codex

Tài khoản Google của Open Design và tài khoản trợ lý AI là hai tài khoản khác nhau.
Open Design không chứa sẵn tài khoản Claude/Codex.

1. Mở **Settings**.
2. Vào **Execution setup**.
3. Tại Claude hoặc Codex, chọn **Đăng nhập**.
4. Hoàn tất đăng nhập trong cửa sổ được mở.
5. Quay lại Settings và kiểm tra trạng thái **Đã đăng nhập**.

Thông tin đăng nhập chỉ được lưu trong vùng dữ liệu Docker riêng trên máy hiện
tại. Cài lại ứng dụng không có nghĩa là đã đăng nhập trợ lý AI trên một máy khác.

## 3. Tạo Dự án và Tính năng

### Tạo Dự án

1. Mở **Quy trình tự động hóa**.
2. Chọn **Dự án mới**.
3. Nhập tên dễ nhận biết, ví dụ `[Nội bộ] - Kế toán`.
4. Chọn hoặc cấu hình Design System nếu Dự án cần sinh giao diện.
5. Xác nhận tạo Dự án.

### Tạo Tính năng

1. Mở thẻ Dự án.
2. Chọn **Tính năng mới**.
3. Nhập tên theo nghiệp vụ, ví dụ “Thanh toán hóa đơn”.
4. Chọn nguồn tài liệu, nền tảng và Design System phù hợp.
5. Lưu Tính năng.

Nên tạo một Tính năng cho một luồng nghiệp vụ có thể chạy và review độc lập.
Không nên gom toàn bộ sản phẩm vào một Tính năng duy nhất.

### Đổi tên hoặc xóa khỏi máy

Mở menu ba chấm của Dự án/Tính năng để đổi tên hoặc xóa.

- **Xóa khỏi máy** chỉ xóa dữ liệu trên máy hiện tại.
- Bản đã chia sẻ trong kho chung không bị xóa.
- Bạn có thể lấy lại bản trong kho chung sau này.

Hãy đọc kỹ cảnh báo vì xóa Dự án sẽ xóa toàn bộ Tính năng và kết quả trên máy bên
trong Dự án đó.

## 4. Chọn quy trình

Mở một Tính năng để xem danh sách quy trình. Open Design hiện có ba luồng chính:

| Quy trình | Khi nào dùng | Kết quả chính |
| --- | --- | --- |
| **URD/PRD → UI-Spec** | Cần chuyển yêu cầu thành hành trình, UX Spec và màn hình. | Customer Journey, UX Research, UX Spec, UI-Spec HTML/React. |
| **URD/PRD → Rà soát yêu cầu** | Cần kiểm tra yêu cầu còn thiếu, mâu thuẫn hoặc chưa rõ. | Báo cáo rà soát PRD/Requirements. |
| **URD/PRD → Rà soát tài liệu** | Cần trợ lý AI đề xuất sửa trực tiếp trên tài liệu. | Tài liệu được đánh dấu thay đổi và bản rà soát. |

Mỗi quy trình có các bước riêng. Kết quả của một bước chỉ được tính là hoàn tất
khi trợ lý AI chạy xong và ứng dụng đã đọc được bản xem trước hợp lệ. Mất mạng,
hết hạn mức hoặc trợ lý AI dừng giữa chừng không được xem là hoàn tất.

## 5. Nạp tài liệu đầu vào

### Chọn tài liệu Confluence

1. Tại bước tài liệu đầu vào, chọn nguồn **Confluence**.
2. Nhập từ khóa vào ô tìm kiếm.
3. Tích một hoặc nhiều tài liệu cần dùng.
4. Với tài liệu có trang con, dùng nút mũi tên tròn ở bên phải để mở sâu hơn.
5. Chọn **Xong** sau khi kiểm tra danh sách.

Hãy chọn đúng trang gốc và các trang con cần thiết. Chọn quá nhiều tài liệu không
liên quan sẽ làm trợ lý AI xử lý chậm và kết quả khó rà soát hơn.

### Nạp tệp từ máy

Bạn cũng có thể kéo thả hoặc chọn tệp Markdown/tài liệu được hỗ trợ. Kiểm tra tên
tệp sau khi nạp để tránh dùng nhầm phiên bản cũ.

## 6. Chạy quy trình

### Chạy một bước

Chọn nút chạy tại bước muốn thực hiện. Chỉ nên chạy bước sau khi các đầu vào bắt
buộc đã sẵn sàng.

### Chạy toàn bộ luồng

1. Kiểm tra các bước được chọn.
2. Chọn **Chạy full luồng**.
3. Theo dõi trạng thái đang chạy ở từng bước.
4. Mở **Quick result** để xem nhanh kết quả sau khi bước hoàn tất.

Nếu chạy lại, kết quả cũ có thể được lưu vào lịch sử trước khi bản mới thay thế.
Không đóng Docker hoặc tắt máy trong khi trợ lý AI đang chạy.

### Trạng thái thường gặp

| Trạng thái | Ý nghĩa | Cách xử lý |
| --- | --- | --- |
| Chưa chạy | Bước chưa có kết quả. | Kiểm tra đầu vào rồi chạy bước. |
| Đang chạy | Agent đang xử lý. | Chờ, hoặc mở workspace để theo dõi. |
| Hoàn tất | Đã có kết quả hợp lệ để xem. | Mở bản xem trước và rà soát. |
| Lỗi | Trợ lý AI hoặc hạ tầng không hoàn thành bước. | Đọc lỗi, kiểm tra mạng/hạn mức rồi thử lại. |

Nếu giao diện đứng lâu ở trạng thái đang chạy, kiểm tra:

- Docker Desktop còn hoạt động không.
- Claude/Codex còn đăng nhập không.
- Tài khoản trợ lý AI còn hạn mức sử dụng không.
- Kết nối mạng có ổn định không.

## 7. Xem và duyệt kết quả

### Quick result

Quick result dùng để xem kết quả mà không rời quy trình. Với Customer Journey,
tab Flow hiển thị danh sách nhóm kịch bản và cho phép chuyển kịch bản trước/sau.
Với UX Spec, bản xem trước có thể kèm màn hình HTML theo nền tảng Mobile App hoặc
Website.

### Rà soát tài liệu

Trong quy trình **URD/PRD → Rà soát tài liệu**:

- Phần trợ lý AI sửa được đánh dấu để bạn kiểm tra.
- Bạn có thể sửa nội dung đề xuất, bỏ đề xuất hoặc khôi phục.
- Bạn có thể tự tạo vùng thêm/sửa/xóa của người dùng.
- Thay đổi của trợ lý AI và của người dùng được ghi nhận riêng.

Sau khi đã chạy và review đủ các bước, chọn **Xác nhận hoàn tất**. Nút này chỉ
được bật khi các bước bắt buộc đã có kết quả. Xác nhận sẽ tạo một snapshot số
liệu; nếu tiếp tục chỉnh sửa, bạn cần xác nhận lại để tạo snapshot mới.

## 8. Design System Figma

### Nạp Design System mới

1. Mở **Design systems**.
2. Chọn chức năng import Figma ZIP.
3. Chọn tệp ZIP và chờ hệ thống kiểm tra.
4. Mở **Danh mục review** để xem Showcase, Thành phần và Nguyên tắc.

### Danh mục review

Modal **Danh mục review** có ba tab:

- **Showcase**: xem tổng quan Design System.
- **Thành phần**: xem tài liệu thành phần đang dùng hoặc bản nháp.
- **Nguyên tắc**: xem quy tắc thiết kế đang dùng hoặc bản nháp.

Nếu chưa có tài liệu Thành phần/Nguyên tắc, chọn CTA mở workspace sinh riêng.
Skill sẽ tự chạy. Sau khi có kết quả:

1. Chọn **Xem bản nháp**.
2. Dùng **Tải lại nội dung** nếu trợ lý AI vừa cập nhật.
3. Review nội dung.
4. Chọn **Duyệt dùng cho Design System**.

Hệ thống không tự duyệt file thay bạn.

### Cập nhật Design System bằng ZIP mới

1. Mở **Danh mục review** của Design System hiện có.
2. Chọn **Cập nhật từ file Figma**.
3. Chọn ZIP mới và tạo bản cập nhật.
4. `components.md` và `rules.md` cũ vẫn được giữ nhưng có thể được đánh dấu
   **Cần cập nhật**.
5. Sinh lại, xem và duyệt từng bản nháp nếu cần.
6. Chọn **Xác nhận duyệt DS** để phát hành phiên bản mới.

Nếu tài liệu Thành phần hoặc Nguyên tắc vẫn cũ, ứng dụng sẽ cảnh báo. Bạn có thể
tiếp tục sau khi xác nhận rõ, nhưng nên cập nhật hai tài liệu để review chính xác.

Design System mới không tự động đổi bộ tài liệu dùng chung (Context) của các Tính năng đang chạy. Bạn có
thể xem khác biệt và chủ động nâng từng Tính năng khi sẵn sàng.

### Chia sẻ hoặc lấy Design System

Tại trang Design System, dùng:

- **Chia sẻ bộ Design System** để đưa phiên bản đã duyệt lên kho chung.
- **Lấy bộ Design System về máy** để lấy một bộ đã được chia sẻ.

Design System đang cập nhật, có bản nháp chưa duyệt hoặc tài liệu **Cần cập nhật** có thể
bị chặn chia sẻ. Lấy Design System về máy không tự áp dụng nó cho Dự án/Tính năng.

## 9. Chia sẻ kết quả lên kho chung

### Chia sẻ một Tính năng

1. Mở Tính năng hoặc chọn biểu tượng chia sẻ tại dòng Tính năng.
2. Chọn **Chia sẻ kết quả**.
3. Chọn Dự án đích trong kho chung; nếu chưa có, chọn tạo mới.
4. Chọn các kết quả của quy trình cần chia sẻ.
5. Xem cây nội dung để biết tệp nào được tạo mới, thay đổi hoặc xóa.
6. Xác nhận chia sẻ.

Tài liệu dùng chung và đúng phiên bản Context mà Tính năng đang sử dụng sẽ đi kèm
để người nhận có thể tiếp tục làm việc đúng chuẩn.

### Chia sẻ toàn bộ Dự án

Tại danh sách Dự án, chọn biểu tượng chia sẻ của Dự án. Phạm vi Dự án gồm:

- Tài liệu và tiêu chuẩn dùng chung.
- Context và các phiên bản cần thiết.
- Các Tính năng được chọn trong modal.
- Kết quả quy trình được chọn riêng cho từng Tính năng.

Với Dự án nhiều Tính năng, kiểm tra từng nhóm Tính năng trước khi xác nhận. Phần
xem trước không ghi dữ liệu; chỉ thao tác xác nhận cuối mới thực sự chia sẻ.

### Ý nghĩa trạng thái đồng bộ

| Trạng thái | Ý nghĩa |
| --- | --- |
| **Tạo mới** | Bản trên máy chưa có trong kho chung hoặc bản cũ đã bị ẩn. |
| **Không thay đổi** | Bản trên máy và kho chung giống nhau. |
| **Có thay đổi** | Có tệp được thêm, sửa hoặc xóa so với kho chung. |
| **Đã xóa** | Nội dung có trong kho chung nhưng không còn trong bản nguồn của thao tác. |

## 10. Lấy Dự án về máy

1. Tại trang **Quy trình tự động hóa**, chọn **Lấy dự án về máy**.
2. Chọn Dự án có quyền truy cập và xem trước Context dùng chung mới nhất.
3. Sau khi Dự án đã có trên máy, mở trang Tính năng và chọn
   **Lấy tính năng từ kho chung** để lấy một hoặc nhiều Tính năng.
4. Xem trước nội dung trước khi ghi vào máy.
5. Nếu có xung đột, chọn **Giữ bản trên máy** hoặc **Dùng bản trong kho chung**
   cho từng tệp.
6. Xác nhận lấy về.

Với Dự án đã có trên máy, thao tác này là cập nhật từ kho chung. Open Design lưu
bản trên máy trước khi cập nhật để giảm rủi ro mất dữ liệu.

Dự án bị quản trị viên ẩn khỏi kho chung sẽ không xuất hiện trong danh sách lấy
về. Bản đã có trên máy vẫn được giữ.

## 11. Cách làm việc khuyến nghị

1. Tạo Dự án và các Tính năng theo phạm vi nghiệp vụ.
2. Chọn đúng Design System và Context trước khi chạy.
3. Nạp URD/PRD rõ ràng, loại bỏ tài liệu không liên quan.
4. Chạy từng bước quan trọng lần đầu để kiểm tra đầu vào.
5. Xem bản kết quả; không coi trạng thái “xong” là đã được con người duyệt.
6. Chỉnh sửa và xác nhận kết quả.
7. Mở phần xem trước Chia sẻ, kiểm tra tệp thay đổi rồi mới đưa lên kho chung.
8. Khi đồng nghiệp cập nhật bản chung, xem diff trước khi lấy về máy.

## 12. Xử lý sự cố nhanh

### “Claude/Codex chưa đăng nhập”

Mở **Settings → Execution setup**, đăng nhập đúng Claude/Codex rồi thử lại. Open
Design không cung cấp tài khoản trợ lý AI dùng chung.

### “Docker chưa sẵn sàng”

Mở Docker Desktop và chờ trạng thái running. Nếu vừa cài hoặc bật VT trên
Windows, khởi động lại máy.

### “Tài khoản chưa kết nối với kho Dự án”

Chọn **Kết nối lại**. Nếu vẫn lỗi, kiểm tra mạng và liên hệ quản trị viên để xác
nhận tài khoản đã có trong hệ thống quyền.

### Bước chạy lỗi hoặc dừng giữa chừng

Kiểm tra mạng, hạn mức sử dụng và trạng thái đăng nhập. Chỉ chạy lại sau khi
nguyên nhân đã được xử lý; kết quả chưa có bản xem trước hợp lệ không được tính
là hoàn tất.

### Không thấy Dự án trong “Lấy dự án về máy”

Dự án có thể chưa được chia sẻ, bạn chưa có quyền, hoặc Dự án đã bị quản trị viên
ẩn khỏi kho chung.

### Chia sẻ bị chặn

Kiểm tra trạng thái kết nối kho chung, bản đích, các kết quả đã chọn và Design
System/Context liên quan. Nếu bản xem trước đã hết hạn do dữ liệu thay đổi, hãy
mở lại rồi xác nhận bằng bản mới.

## 13. Checklist trước khi bàn giao

- [ ] Đã chọn đúng Dự án và Tính năng.
- [ ] Đã dùng đúng phiên bản URD/PRD.
- [ ] Đã kiểm tra Design System/Context.
- [ ] Các bước cần thiết đã có bản xem trước hợp lệ.
- [ ] Designer/BA đã rà soát kết quả của trợ lý AI.
- [ ] Quy trình rà soát tài liệu đã **Xác nhận hoàn tất** nếu áp dụng.
- [ ] Đã xem danh sách tệp thêm/sửa/xóa trước khi chia sẻ.
- [ ] Đã chọn đúng Dự án đích trong kho chung.
- [ ] Đồng nghiệp nhận bàn giao đã có quyền truy cập.
