# Tool tong hop HideMyAcc

Tool local de dong bo folder/profile HideMyAcc 3.0 voi Google Sheet.

## Chay tool

```powershell
npm start
```

Mo:

```text
http://127.0.0.1:5177
```

## Cau hinh Google Sheet

Tool dung Service Account cua Google Cloud.

1. Tao Service Account va tai file JSON key.
2. Share Google Sheet cho email `client_email` trong file JSON do voi quyen Editor.
3. Trong giao dien tool, nhap:
   - Spreadsheet ID: doan ID trong URL Google Sheet.
   - Service Account JSON: duong dan file JSON key.
4. Bam luu cau hinh, sau do bam dong bo.

## Nguyen tac dong bo

- Folder trong HideMyAcc tuong ung voi tung trang tinh trong Google Sheet.
- Profile duoc nhan dien bang cot `id hide`.
- Nut Run/Stop chi nam trong giao dien tool, khong ghi cot `run` len Sheet.
- Thu tu cot he thong: `ten profile hien tai`, `ten profile khoa cung`, `id hide`, `uid`.
- Tool cap nhat cot `ten profile hien tai` theo ten profile dang co trong HideMyAcc.
- Cot `ten profile khoa cung` va `uid` chi duoc khoa mot lan theo `id hide` khi profile co UID hop le.
- Neu chua khoa duoc UID, cot `ten profile khoa cung` va `uid` se ghi `chua co id khoa cung`.
- Sau khi da khoa, doi ten profile trong HideMyAcc se khong lam mat UID va ten khoa cung.
- Cac cot khac do ban tu dien se di theo profile khi profile doi folder.
- Profile hoac folder bi xoa trong HideMyAcc se duoc chuyen sang trang `rac`.
- UID duoc loc tu ten profile theo day 13-15 chu so bat dau bang `6` hoac `1`.
- Tool tu tai lai du lieu HideMyAcc moi 5 giay. Neu da cau hinh Google Sheet, khi HideMyAcc thay doi thi tool se tu dong bo Sheet.
- UID trung se duoc canh bao trong tool va to do tren Sheet sau khi dong bo.
