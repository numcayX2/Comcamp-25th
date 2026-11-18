package service

import "testing"

func TestThaiProvinces_OfficialList(t *testing.T) {
	if len(provinceSet) != 77 || len(thaiProvinces) != 77 {
		t.Fatalf("want 77 distinct provinces, got %d entries / %d distinct", len(thaiProvinces), len(provinceSet))
	}
	for short, name := range provinceAliases {
		if !isThaiProvince(name) {
			t.Errorf("alias %q points to %q, which is not in the list", short, name)
		}
	}
}
