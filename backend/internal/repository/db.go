package repository

import (
	"context"
	"errors"
	"fmt"
	"log"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
)

const (
	DefaultConnectTimeout    = 5 * time.Second
	DefaultHealthCheckPeriod = 30 * time.Second
	DefaultQueryTimeout      = 5 * time.Second
)

type PoolConfig struct {
	DSN               string
	MaxConns          int32
	MinConns          int32
	MaxConnLifetime   time.Duration
	MaxConnIdleTime   time.Duration
	ConnectTimeout    time.Duration
	HealthCheckPeriod time.Duration
	QueryTimeout      time.Duration
}

func DefaultPoolConfig(dsn string) PoolConfig {
	return PoolConfig{
		DSN:               dsn,
		MaxConns:          25,
		MinConns:          5,
		MaxConnLifetime:   time.Hour,
		MaxConnIdleTime:   30 * time.Minute,
		ConnectTimeout:    DefaultConnectTimeout,
		HealthCheckPeriod: DefaultHealthCheckPeriod,
		QueryTimeout:      DefaultQueryTimeout,
	}
}

func NewPool(ctx context.Context, cfg PoolConfig) (*pgxpool.Pool, error) {
	poolConfig, err := pgxpool.ParseConfig(cfg.DSN)
	if err != nil {
		return nil, fmt.Errorf("failed to parse pgxpool config: %w", err)
	}

	connectTimeout := cfg.ConnectTimeout
	if connectTimeout <= 0 {
		connectTimeout = DefaultConnectTimeout
	}
	healthCheckPeriod := cfg.HealthCheckPeriod
	if healthCheckPeriod <= 0 {
		healthCheckPeriod = DefaultHealthCheckPeriod
	}

	poolConfig.MaxConns = cfg.MaxConns
	poolConfig.MinConns = cfg.MinConns
	poolConfig.MaxConnLifetime = cfg.MaxConnLifetime
	poolConfig.MaxConnIdleTime = cfg.MaxConnIdleTime
	poolConfig.HealthCheckPeriod = healthCheckPeriod
	poolConfig.ConnConfig.ConnectTimeout = connectTimeout

	ctxTimeout, cancel := context.WithTimeout(ctx, connectTimeout)
	defer cancel()

	pool, err := pgxpool.NewWithConfig(ctxTimeout, poolConfig)
	if err != nil {
		return nil, fmt.Errorf("failed to create pgxpool: %w", err)
	}

	if err := pool.Ping(ctxTimeout); err != nil {
		pool.Close()
		return nil, fmt.Errorf("failed to ping postgres database: %w", err)
	}

	log.Printf("Successfully connected to PostgreSQL connection pool (max: %d, min: %d)", cfg.MaxConns, cfg.MinConns)
	return pool, nil
}

// WithQueryTimeout returns a child context bounded by timeout (defaulting to DefaultQueryTimeout).
func WithQueryTimeout(ctx context.Context, timeout time.Duration) (context.Context, context.CancelFunc) {
	if timeout <= 0 {
		timeout = DefaultQueryTimeout
	}
	return context.WithTimeout(ctx, timeout)
}

// Ping verifies database connectivity within a bounded timeout.
func Ping(ctx context.Context, pool *pgxpool.Pool) error {
	if pool == nil {
		return errors.New("database pool is nil")
	}
	pingCtx, cancel := WithQueryTimeout(ctx, 3*time.Second)
	defer cancel()
	return pool.Ping(pingCtx)
}
