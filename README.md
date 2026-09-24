# pole-scan

ポール貸出の試作用、カメラ読み取りページ。

- スマホのカメラでバーコード（Code128）を読み、番号を Google Apps Script の窓口に送る
- 貸出・返却の判断と記録は Apps Script 側で行う。このページには暗証番号・個人情報・秘密の値を置かない
- 暗証番号はログインの1回だけ送り、以降は12時間で切れる合言葉で通信する
- バーコードの読み取りには [ZXing](https://github.com/zxing-js/library)（Apache-2.0、`LICENSE-zxing`）を同梱している。外部のサイトからは読み込まない
