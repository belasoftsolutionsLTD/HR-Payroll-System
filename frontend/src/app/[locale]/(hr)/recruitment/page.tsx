import { setRequestLocale } from 'next-intl/server';
import { RecruitmentDashboardPage } from '@/features/recruitment/Pages/RecruitmentDashboardPage';

export default function Page({ params: { locale } }: { params: { locale: string } }) {
  setRequestLocale(locale);
  return <RecruitmentDashboardPage locale={locale} />;
}
