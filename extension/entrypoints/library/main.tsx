import App from './App';
import { mountPage } from '@/components/shared/mount-page';

mountPage(App, 'library', (messages) => messages.common.library);
