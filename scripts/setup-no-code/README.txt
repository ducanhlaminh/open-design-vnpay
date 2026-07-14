CÀI ĐẶT MÁY LẦN ĐẦU - Open Design (VNPAY)
==========================================

Chỉ làm 1 LẦN duy nhất cho mỗi máy, TRƯỚC KHI dùng pipeline lần đầu (app
vẫn mở bình thường không cần setup, chỉ các bước chạy AI agent mới cần).

macOS
-----
1. Cài app: mở file "Open Design-<version>-mac-<arch>.dmg" -> kéo
   "Open Design.app" vào Applications.
2. Trên trang GitHub Releases, tải thêm file
   "open-design-<version>-setup-no-code-mac.zip" -> giải nén ra, sẽ thấy
   file setup-open-design-mac.command.
3. Nhấn chuột phải vào file đó -> chọn "Open" (lần đầu macOS sẽ hỏi xác
   nhận, chọn "Open" là được).
4. Một cửa sổ đen (Terminal) hiện ra, cứ để nó chạy tới khi thấy dòng chữ
   "Xong! Giờ mở app Open Design...".
5. Nếu có cửa sổ trình duyệt bật lên hỏi đăng nhập - đăng nhập tài khoản
   Claude/Anthropic của bạn (chỉ 1 lần).
6. Mở app "Open Design" đã cài, đăng nhập bằng Google là dùng được.

Windows
-------
1. Tải file "open-design-<version>-win-x64-portable.zip" trên trang GitHub
   Releases -> giải nén ra một thư mục (vd C:\OpenDesign).
2. Vào thư mục "win-unpacked" - bên trong đã CÓ SẴN file
   setup-open-design-windows.bat (không cần tải/copy gì thêm).
3. Double-click file setup-open-design-windows.bat.
4. Một cửa sổ đen hiện ra, cứ để nó chạy tới khi thấy dòng chữ
   "Xong! Giờ mở Open Design.exe...".
5. Nếu có cửa sổ trình duyệt bật lên hỏi đăng nhập - đăng nhập tài khoản
   Claude/Anthropic của bạn (chỉ 1 lần).
6. Mở "Open Design.exe" (cùng thư mục), đăng nhập bằng Google là dùng được.

Cần gì trước đó?
----------------
- Máy cần có internet trong lúc chạy script này (tải Docker + build ảnh
  Docker + đăng nhập).
- Nếu chưa có Docker Desktop, script sẽ tự cài (cần quyền admin xác nhận
  1-2 lần qua hộp thoại của hệ điều hành).
- Nếu Docker Desktop mới cài lần đầu, đôi khi cần KHỞI ĐỘNG LẠI MÁY rồi
  chạy lại script này 1 lần nữa.

Gặp lỗi?
--------
- Cứ chạy lại script - script biết bỏ qua những bước đã xong (không build
  lại từ đầu, không cài lại Docker nếu đã có).
- Nếu vẫn lỗi, chụp màn hình cửa sổ đen gửi cho người phụ trách kỹ thuật.
