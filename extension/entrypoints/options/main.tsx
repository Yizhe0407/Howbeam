import App from './App';
import { mountPage } from '@/components/shared/mount-page';

mountPage(App, 'options', (messages) => messages.settings.title);
