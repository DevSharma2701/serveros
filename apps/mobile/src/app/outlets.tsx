import { useRouter } from 'expo-router';
import { OutletPicker } from '../components/outlet-picker';

/** Switch outlet from inside the app (opened from the header and from Profile). */
export default function SwitchOutletScreen() {
  const router = useRouter();
  return <OutletPicker onPicked={() => (router.canGoBack() ? router.back() : router.replace('/'))} />;
}
