CAI DAT MAY LAN DAU - Open Design (VNPAY)
==========================================

Chi lam 1 LAN duy nhat cho moi may, TRUOC KHI dung pipeline lan dau (app
van mo binh thuong khong can setup, chi cac buoc chay AI agent moi can).

macOS
-----
1. Cai app: mo file "Open Design-<version>-mac-<arch>.dmg" -> keo
   "Open Design.app" vao Applications.
2. Tren trang GitHub Releases, tai them file
   "open-design-<version>-setup-no-code-mac.zip" -> giai nen ra, se thay
   file setup-open-design-mac.command.
3. Nhan chuot phai vao file do -> chon "Open" (lan dau macOS se hoi xac
   nhan, chon "Open" la duoc).
4. Mot cua so den (Terminal) hien ra, cu de no chay toi khi thay dong chu
   "Xong! Gio mo app Open Design...".
5. Neu co cua so trinh duyet bat len hoi dang nhap - dang nhap tai khoan
   Claude/Anthropic cua ban (chi 1 lan).
6. Mo app "Open Design" da cai, dang nhap bang Google la dung duoc.

Windows
-------
1. Tai file "open-design-<version>-win-x64-portable.zip" tren trang GitHub
   Releases -> giai nen ra mot thu muc (vd C:\OpenDesign).
2. Vao thu muc "win-unpacked" - ben trong da CO SAN file
   setup-open-design-windows.bat (khong can tai/copy gi them).
3. Double-click file setup-open-design-windows.bat.
4. Mot cua so den hien ra, cu de no chay toi khi thay dong chu
   "Xong! Gio mo Open Design.exe...".
5. Neu co cua so trinh duyet bat len hoi dang nhap - dang nhap tai khoan
   Claude/Anthropic cua ban (chi 1 lan).
6. Mo "Open Design.exe" (cung thu muc), dang nhap bang Google la dung duoc.

Can gi truoc do?
----------------
- May can co internet trong luc chay script nay (tai Docker + build anh
  Docker + dang nhap).
- Neu chua co Docker Desktop, script se tu cai (can quyen admin xac nhan
  1-2 lan qua hop thoai cua he dieu hanh).
- Neu Docker Desktop moi cai lan dau, doi khi can KHOI DONG LAI MAY roi
  chay lai script nay 1 lan nua.

Gap loi?
--------
- Cu chay lai script - script biet bo qua nhung buoc da xong (khong build
  lai tu dau, khong cai lai Docker neu da co).
- Neu van loi, chup man hinh cua so den gui cho nguoi phu trach ky thuat.
