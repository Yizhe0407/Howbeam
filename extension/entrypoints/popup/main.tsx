import App from './App.tsx';
import { mountPage } from '@/components/shared/mount-page';

mountPage(App, 'popup', (messages) => messages.common.appName);
