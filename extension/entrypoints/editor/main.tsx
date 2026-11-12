import App from './App.tsx';
import { mountPage } from '@/components/shared/mount-page';

mountPage(App, 'editor', (messages) => messages.common.editor);
