import { ReactNode } from 'react';
import { Header } from './Header';

interface MainLayoutProps {
  children: ReactNode;
  fullHeight?: boolean;
}

export function MainLayout({ children, fullHeight = false }: MainLayoutProps) {
  return (
    <div className="min-h-screen bg-background flex flex-col">
      <Header />
      <main className={`flex-1 ${fullHeight ? '' : 'container px-4 py-6'}`}>
        {children}
      </main>
      
      {/* Background grid overlay */}
      <div className="fixed inset-0 pointer-events-none grid-overlay opacity-30 z-[-1]" />
    </div>
  );
}
