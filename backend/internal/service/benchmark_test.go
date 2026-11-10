package service_test

import (
	"context"
	"fmt"
	"testing"

	"comcamp25-backend/internal/repository/memory"
	"comcamp25-backend/internal/service"
)

func BenchmarkApplicantService_Submit(b *testing.B) {
	appRepo := memory.NewMemoryApplicantRepo()
	setRepo := memory.NewMemorySettingRepo()
	payRepo := memory.NewMemoryPaymentRepo(appRepo)
	svc := service.NewApplicantService(appRepo, setRepo, payRepo)

	ctx := context.Background()

	b.ResetTimer()
	b.ReportAllocs()

	for i := 0; i < b.N; i++ {
		req := service.ApplicationCreateRequest{
			FullName:   fmt.Sprintf("นักเรียน %d", i),
			Nickname:   "นนท์",
			NationalID: validTestNationalID(i),
			Phone:      fmt.Sprintf("08%08d", i),
			Email:      fmt.Sprintf("student%d@school.ac.th", i),
			School:     "โรงเรียนแม่โจ้วิทยาคม",
			Grade:      "ม.5",
			ShirtSize:  "L",
			Motivation: "อยากเรียนรู้ IoT และ Arduino",
		}
		_, err := svc.Submit(ctx, req)
		if err != nil && err != service.ErrQuotaExceeded {
			b.Fatalf("unexpected error: %v", err)
		}
	}
}

func BenchmarkApplicantService_QueryStatus(b *testing.B) {
	appRepo := memory.NewMemoryApplicantRepo()
	setRepo := memory.NewMemorySettingRepo()
	payRepo := memory.NewMemoryPaymentRepo(appRepo)
	svc := service.NewApplicantService(appRepo, setRepo, payRepo)

	ctx := context.Background()

	var testAppNo string
	for i := 0; i < 30; i++ {
		res, _ := svc.Submit(ctx, service.ApplicationCreateRequest{
			FullName:   fmt.Sprintf("นักเรียน %d", i),
			Nickname:   "นนท์",
			NationalID: validTestNationalID(i),
			Phone:      fmt.Sprintf("08%08d", i),
			Email:      fmt.Sprintf("student%d@school.ac.th", i),
			School:     "โรงเรียนแม่โจ้วิทยาคม",
			Grade:      "ม.5",
			ShirtSize:  "L",
		})
		if i == 15 && res != nil {
			testAppNo = res.ID
		}
	}

	b.ResetTimer()
	b.ReportAllocs()

	for i := 0; i < b.N; i++ {
		_, err := svc.QueryStatus(ctx, testAppNo)
		if err != nil {
			b.Fatalf("failed to query status: %v", err)
		}
	}
}
