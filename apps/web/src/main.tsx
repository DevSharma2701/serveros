import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router';
import { App } from './App';
import { ToastProvider } from './components/ui';
import { ApiError } from './lib/api';
import { AuthProvider } from './lib/auth';
import { reportOffline } from './lib/online';
import { GuestPage } from './pages/guest/GuestPage';
import './index.css';

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 15_000,
      refetchOnWindowFocus: true,
      // Retrying cannot fix a permission or validation error; only retry what might be temporary.
      retry: (failures, error) => failures < 2 && (!(error instanceof ApiError) || error.status === 0 || error.status >= 500),
    },
  },
});
queryClient.getQueryCache().config.onError = (error) => {
  if (error instanceof ApiError && error.isNetwork) reportOffline();
};

// A table QR code opens /t/<secret>. That page is for guests: it never loads the staff app.
const guestTable = /^\/t\/([\w-]{20,80})\/?$/.exec(window.location.pathname)?.[1];

createRoot(document.getElementById('root')!).render(
  guestTable ? (
    <StrictMode>
      <QueryClientProvider client={queryClient}>
        <ToastProvider>
          <GuestPage tableToken={guestTable} />
        </ToastProvider>
      </QueryClientProvider>
    </StrictMode>
  ) : (
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <BrowserRouter>
        <ToastProvider>
          <AuthProvider>
            <App />
          </AuthProvider>
        </ToastProvider>
      </BrowserRouter>
    </QueryClientProvider>
  </StrictMode>
  ),
);
