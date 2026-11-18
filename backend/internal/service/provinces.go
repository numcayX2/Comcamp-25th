package service

import "strings"

// thaiProvinces is the official list of Thailand's 77 provinces (76 provinces plus Bangkok), in
// Thai dictionary order. frontend/src/lib/provinces.ts carries the same list for the picker.
var thaiProvinces = [...]string{
	"กรุงเทพมหานคร", "กระบี่", "กาญจนบุรี", "กาฬสินธุ์", "กำแพงเพชร", "ขอนแก่น", "จันทบุรี",
	"ฉะเชิงเทรา", "ชลบุรี", "ชัยนาท", "ชัยภูมิ", "ชุมพร", "เชียงราย", "เชียงใหม่", "ตรัง", "ตราด",
	"ตาก", "นครนายก", "นครปฐม", "นครพนม", "นครราชสีมา", "นครศรีธรรมราช", "นครสวรรค์", "นนทบุรี",
	"นราธิวาส", "น่าน", "บึงกาฬ", "บุรีรัมย์", "ปทุมธานี", "ประจวบคีรีขันธ์", "ปราจีนบุรี", "ปัตตานี",
	"พระนครศรีอยุธยา", "พะเยา", "พังงา", "พัทลุง", "พิจิตร", "พิษณุโลก", "เพชรบุรี", "เพชรบูรณ์",
	"แพร่", "ภูเก็ต", "มหาสารคาม", "มุกดาหาร", "แม่ฮ่องสอน", "ยโสธร", "ยะลา", "ร้อยเอ็ด", "ระนอง",
	"ระยอง", "ราชบุรี", "ลพบุรี", "ลำปาง", "ลำพูน", "เลย", "ศรีสะเกษ", "สกลนคร", "สงขลา", "สตูล",
	"สมุทรปราการ", "สมุทรสงคราม", "สมุทรสาคร", "สระแก้ว", "สระบุรี", "สิงห์บุรี", "สุโขทัย",
	"สุพรรณบุรี", "สุราษฎร์ธานี", "สุรินทร์", "หนองคาย", "หนองบัวลำภู", "อ่างทอง", "อำนาจเจริญ",
	"อุดรธานี", "อุตรดิตถ์", "อุทัยธานี", "อุบลราชธานี",
}

// provinceAliases maps common short forms to the official name.
var provinceAliases = map[string]string{
	"กทม":      "กรุงเทพมหานคร",
	"กทม.":     "กรุงเทพมหานคร",
	"กรุงเทพ":  "กรุงเทพมหานคร",
	"กรุงเทพฯ": "กรุงเทพมหานคร",
	"อยุธยา":   "พระนครศรีอยุธยา",
	"โคราช":    "นครราชสีมา",
}

var provinceSet = func() map[string]struct{} {
	m := make(map[string]struct{}, len(thaiProvinces))
	for _, p := range thaiProvinces {
		m[p] = struct{}{}
	}
	return m
}()

// canonicalProvince maps a cleaned province value to its official name: a "จังหวัด" / "จ."
// prefix and inner spaces are dropped and the short forms above are expanded ("จ. ลำปาง" →
// "ลำปาง", "กทม" → "กรุงเทพมหานคร"). A value that matches no province is returned unchanged.
func canonicalProvince(s string) string {
	key := strings.TrimPrefix(s, "จังหวัด")
	key = strings.TrimPrefix(key, "จ.")
	key = strings.ReplaceAll(key, " ", "")
	if _, ok := provinceSet[key]; ok {
		return key
	}
	if p, ok := provinceAliases[key]; ok {
		return p
	}
	return s
}

func isThaiProvince(s string) bool {
	_, ok := provinceSet[s]
	return ok
}
