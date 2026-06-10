import { type CSSProperties } from 'react';

interface SkeletonProps {
  className?: string;
  style?: CSSProperties;
  rounded?: 'none' | 'sm' | 'md' | 'lg' | 'xl' | 'full';
}

const roundedClass: Record<NonNullable<SkeletonProps['rounded']>, string> = {
  none: '',
  sm: 'rounded-sm',
  md: 'rounded-md',
  lg: 'rounded-lg',
  xl: 'rounded-xl',
  full: 'rounded-full',
};

export function Skeleton({ className = '', style, rounded = 'md' }: SkeletonProps) {
  return (
    <div
      aria-hidden
      className={`bg-bg-tertiary skeleton-shimmer ${roundedClass[rounded]} ${className}`}
      style={style}
    />
  );
}
