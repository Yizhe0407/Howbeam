import App from './App';
import { mountPage } from '@/components/shared/mount-page';

mountPage(App, 'welcome', (messages) => messages.welcome.crumb);
